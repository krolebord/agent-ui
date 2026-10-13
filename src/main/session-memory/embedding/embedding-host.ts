import { type ChildProcess, fork } from "node:child_process";
import path from "node:path";
import { createDisposable } from "@shared/utils";
import log from "../../logger";
import {
  DEFAULT_EMBEDDING_MAX_TOKENS,
  DEFAULT_EMBEDDING_THREADS,
  type Embedder,
  type EmbeddingDocument,
} from "./embedder";
import {
  type EmbeddingWorkerConfig,
  type EmbeddingWorkerRequest,
  type EmbeddingWorkerResponse,
  embeddingWorkerResponseSchema,
} from "./ipc";

export const EMBEDDING_WORKER_FILE = "embedding-worker.js";

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 2_000;
const STDERR_TAIL_BYTES = 4_096;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type WorkerRequestPayload = DistributiveOmit<EmbeddingWorkerRequest, "id">;

export interface EmbeddingWorkerProcess {
  send(message: EmbeddingWorkerRequest): boolean;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  readonly stderr?: NodeJS.ReadableStream | null;
}

export type SpawnEmbeddingWorker = (
  config: EmbeddingWorkerConfig,
) => EmbeddingWorkerProcess;

/** Headless sets APP_ROOT to the release root; the worker is emitted next to `dist-headless/index.js`. */
export function resolveEmbeddingWorkerPath(
  appRoot = process.env.APP_ROOT,
): string {
  if (!appRoot) {
    throw new Error("APP_ROOT is not set; cannot locate the embedding worker");
  }
  return path.join(appRoot, "dist-headless", EMBEDDING_WORKER_FILE);
}

export function forkEmbeddingWorker(
  workerPath: string,
  config: EmbeddingWorkerConfig,
): ChildProcess {
  return fork(workerPath, [JSON.stringify(config)], {
    execArgv: [],
    serialization: "advanced",
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
}

export interface EmbeddingHostOptions {
  modelDir: string;
  workerPath?: string;
  spawn?: SpawnEmbeddingWorker;
  maxTokens?: number;
  threads?: number;
  idleTimeoutMs?: number;
  /** Per text in a request, so large batches get proportionally longer. */
  requestTimeoutMs?: number;
}

interface Job {
  payload: WorkerRequestPayload;
  textCount: number;
  resolve: (response: EmbeddingWorkerResponse) => void;
  reject: (error: Error) => void;
}

interface RunningWorker {
  process: EmbeddingWorkerProcess;
  stderrTail: string;
  exited: Promise<void>;
}

interface InFlight {
  id: number;
  job: Job;
  worker: RunningWorker;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Runs the embedding model in a niced child process that is spawned on demand
 * and exits after `idleTimeoutMs`, so its memory goes back to the OS.
 * Requests run one at a time; queries are served before queued documents.
 */
export class EmbeddingHost implements Embedder {
  private readonly config: EmbeddingWorkerConfig;
  private readonly spawnWorker: SpawnEmbeddingWorker;
  private readonly idleTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly queryQueue: Job[] = [];
  private readonly documentQueue: Job[] = [];
  private worker: RunningWorker | null = null;
  private inFlight: InFlight | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 0;
  private disposed = false;
  private readonly disposable = createDisposable({
    onError: (error) => log.error("Embedding host teardown failed", { error }),
  });

  constructor(options: EmbeddingHostOptions) {
    this.config = {
      modelDir: options.modelDir,
      maxTokens: options.maxTokens ?? DEFAULT_EMBEDDING_MAX_TOKENS,
      threads: options.threads ?? DEFAULT_EMBEDDING_THREADS,
    };
    this.spawnWorker =
      options.spawn ??
      ((config) =>
        forkEmbeddingWorker(
          options.workerPath ?? resolveEmbeddingWorkerPath(),
          config,
        ));
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.disposable.addDisposable(() => this.shutdown());
  }

  get isWorkerRunning(): boolean {
    return this.worker !== null;
  }

  async embedDocuments(
    documents: EmbeddingDocument[],
  ): Promise<Float32Array[]> {
    if (documents.length === 0) return [];
    const response = await this.request(
      {
        type: "embedDocuments",
        documents: documents.map(({ title, text }) => ({ title, text })),
      },
      documents.length,
    );
    return this.expectVectors(response, documents.length);
  }

  async embedQuery(query: string): Promise<Float32Array> {
    const response = await this.request(
      { type: "embedQueries", queries: [query] },
      1,
    );
    const [vector] = this.expectVectors(response, 1);
    return vector;
  }

  async countTokens(texts: string[]): Promise<number[]> {
    if (texts.length === 0) return [];
    const response = await this.request(
      { type: "countTokens", texts },
      texts.length,
    );
    if (
      response.type !== "tokenCounts" ||
      response.counts.length !== texts.length
    ) {
      throw new Error("Embedding worker returned an unexpected response");
    }
    return response.counts;
  }

  dispose(): Promise<void> {
    return this.disposable.dispose();
  }

  private expectVectors(
    response: EmbeddingWorkerResponse,
    count: number,
  ): Float32Array[] {
    if (response.type !== "vectors" || response.vectors.length !== count) {
      throw new Error("Embedding worker returned an unexpected response");
    }
    return response.vectors;
  }

  private request(
    payload: WorkerRequestPayload,
    textCount: number,
  ): Promise<EmbeddingWorkerResponse> {
    if (this.disposed) {
      return Promise.reject(new Error("Embedding host is disposed"));
    }
    return new Promise((resolve, reject) => {
      const queue =
        payload.type === "embedQueries" ? this.queryQueue : this.documentQueue;
      queue.push({ payload, textCount, resolve, reject });
      this.pump();
    });
  }

  private pump() {
    if (this.inFlight || this.disposed) return;
    const job = this.queryQueue.shift() ?? this.documentQueue.shift();
    if (!job) {
      this.scheduleIdleExit();
      return;
    }
    this.clearIdleTimer();

    let worker: RunningWorker;
    try {
      worker = this.worker ?? this.startWorker();
    } catch (error) {
      job.reject(error instanceof Error ? error : new Error(String(error)));
      this.pump();
      return;
    }

    const id = this.nextId++;
    const timeoutMs = this.requestTimeoutMs * Math.max(1, job.textCount);
    this.inFlight = {
      id,
      job,
      worker,
      timeout: setTimeout(() => {
        this.failInFlight(
          new Error(`Embedding worker timed out after ${timeoutMs} ms`),
        );
        this.killWorker(worker);
      }, timeoutMs),
    };
    try {
      worker.process.send({ ...job.payload, id } as EmbeddingWorkerRequest);
    } catch (error) {
      this.failInFlight(
        error instanceof Error ? error : new Error(String(error)),
      );
      this.killWorker(worker);
    }
  }

  private startWorker(): RunningWorker {
    const child = this.spawnWorker(this.config);
    let markExited: () => void = () => {};
    const worker: RunningWorker = {
      process: child,
      stderrTail: "",
      exited: new Promise((resolve) => {
        markExited = resolve;
      }),
    };
    this.worker = worker;

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      worker.stderrTail = (worker.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    child.on("message", (message) => this.handleMessage(worker, message));
    child.on("error", (error) => {
      log.warn("Embedding worker process error", { error });
      if (this.inFlight?.worker === worker) {
        this.failInFlight(error);
        this.killWorker(worker);
      }
    });
    child.on("exit", (code, signal) => {
      markExited();
      if (this.worker === worker) {
        this.worker = null;
      }
      if (this.inFlight?.worker === worker) {
        const details = worker.stderrTail.trim();
        const error = new Error(
          `Embedding worker exited (code ${code}, signal ${signal})${details ? `: ${details}` : ""}`,
        );
        log.warn("Embedding worker exited during a request", {
          code,
          signal,
          stderr: details,
        });
        this.failInFlight(error);
      }
    });
    return worker;
  }

  private handleMessage(worker: RunningWorker, message: unknown) {
    const parsed = embeddingWorkerResponseSchema.safeParse(message);
    const inFlight = this.inFlight;
    if (!inFlight || inFlight.worker !== worker) return;
    if (!parsed.success) {
      this.failInFlight(
        new Error(`Invalid embedding worker response: ${parsed.error.message}`),
      );
      return;
    }
    const response = parsed.data;
    if (response.id !== null && response.id !== inFlight.id) return;
    clearTimeout(inFlight.timeout);
    this.inFlight = null;
    if (response.type === "error") {
      inFlight.job.reject(new Error(response.message));
    } else {
      inFlight.job.resolve(response);
    }
    this.pump();
  }

  private failInFlight(error: Error) {
    const inFlight = this.inFlight;
    if (!inFlight) return;
    clearTimeout(inFlight.timeout);
    this.inFlight = null;
    inFlight.job.reject(error);
    queueMicrotask(() => this.pump());
  }

  private scheduleIdleExit() {
    if (!this.worker || this.idleTimer) return;
    const worker = this.worker;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.worker === worker && !this.inFlight) {
        this.killWorker(worker);
      }
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private killWorker(worker: RunningWorker) {
    if (this.worker === worker) {
      this.worker = null;
    }
    worker.process.kill("SIGTERM");
    const forceKill = setTimeout(() => {
      worker.process.kill("SIGKILL");
    }, KILL_GRACE_MS);
    forceKill.unref?.();
    void worker.exited.then(() => clearTimeout(forceKill));
  }

  private async shutdown() {
    this.disposed = true;
    this.clearIdleTimer();
    const error = new Error("Embedding host is disposed");
    this.failInFlight(error);
    for (const job of this.queryQueue.splice(0)) job.reject(error);
    for (const job of this.documentQueue.splice(0)) job.reject(error);
    const worker = this.worker;
    if (worker) {
      this.killWorker(worker);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        worker.exited,
        new Promise((resolve) => {
          timeout = setTimeout(resolve, KILL_GRACE_MS * 2);
        }),
      ]);
      clearTimeout(timeout);
    }
  }
}
