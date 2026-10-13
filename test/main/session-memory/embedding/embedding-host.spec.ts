import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMBEDDING_DIMENSIONS } from "../../../../src/main/session-memory/embedding/embedder";
import {
  EmbeddingHost,
  type EmbeddingWorkerProcess,
} from "../../../../src/main/session-memory/embedding/embedding-host";
import type {
  EmbeddingWorkerConfig,
  EmbeddingWorkerRequest,
} from "../../../../src/main/session-memory/embedding/ipc";

vi.mock("../../../../src/main/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

class FakeWorker extends EventEmitter implements EmbeddingWorkerProcess {
  readonly sent: EmbeddingWorkerRequest[] = [];
  readonly signals: Array<NodeJS.Signals | undefined> = [];
  readonly stderr = new PassThrough();
  exited = false;

  constructor(readonly config: EmbeddingWorkerConfig) {
    super();
  }

  send(message: EmbeddingWorkerRequest): boolean {
    this.sent.push(message);
    return true;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (!this.exited) {
      queueMicrotask(() => this.exit(null, signal ?? "SIGTERM"));
    }
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null) {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
  }

  lastRequest(): EmbeddingWorkerRequest {
    const request = this.sent.at(-1);
    if (!request) throw new Error("No request sent");
    return request;
  }

  replyVectors(count: number, fill = 0.5) {
    this.emit("message", {
      id: this.lastRequest().id,
      type: "vectors",
      vectors: Array.from({ length: count }, () =>
        new Float32Array(EMBEDDING_DIMENSIONS).fill(fill),
      ),
    });
  }
}

function createHost(options: { idleTimeoutMs?: number } = {}) {
  const workers: FakeWorker[] = [];
  const host = new EmbeddingHost({
    modelDir: "/models/test",
    idleTimeoutMs: options.idleTimeoutMs ?? 1_000,
    requestTimeoutMs: 10_000,
    spawn: (config) => {
      const worker = new FakeWorker(config);
      workers.push(worker);
      return worker;
    },
  });
  return { host, workers };
}

describe("EmbeddingHost", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns the worker on the first request with the configured options", async () => {
    const { host, workers } = createHost();
    expect(workers).toHaveLength(0);

    const result = host.embedDocuments([{ title: null, text: "hello" }]);
    expect(workers).toHaveLength(1);
    expect(workers[0].config).toEqual({
      modelDir: "/models/test",
      maxTokens: 1024,
      threads: 2,
    });
    expect(workers[0].lastRequest()).toEqual({
      id: 0,
      type: "embedDocuments",
      documents: [{ title: null, text: "hello" }],
    });
    workers[0].replyVectors(1);

    const vectors = await result;
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(host.isWorkerRunning).toBe(true);
    await host.dispose();
  });

  it("returns token counts and reuses the running worker", async () => {
    const { host, workers } = createHost();
    const first = host.countTokens(["a", "b c"]);
    workers[0].emit("message", {
      id: workers[0].lastRequest().id,
      type: "tokenCounts",
      counts: [3, 4],
    });
    await expect(first).resolves.toEqual([3, 4]);

    const query = host.embedQuery("what changed?");
    expect(workers).toHaveLength(1);
    expect(workers[0].lastRequest()).toMatchObject({
      type: "embedQueries",
      queries: ["what changed?"],
    });
    workers[0].replyVectors(1);
    await expect(query).resolves.toHaveLength(EMBEDDING_DIMENSIONS);
    await host.dispose();
  });

  it("sends one request at a time and serves queries before queued documents", async () => {
    const { host, workers } = createHost();
    const firstDocuments = host.embedDocuments([{ title: "a", text: "a" }]);
    const secondDocuments = host.embedDocuments([{ title: "b", text: "b" }]);
    const query = host.embedQuery("q");
    const worker = workers[0];
    expect(worker.sent).toHaveLength(1);

    worker.replyVectors(1);
    await firstDocuments;
    expect(worker.sent).toHaveLength(2);
    expect(worker.lastRequest().type).toBe("embedQueries");

    worker.replyVectors(1);
    await query;
    expect(worker.lastRequest().type).toBe("embedDocuments");
    worker.replyVectors(1);
    await secondDocuments;
    await host.dispose();
  });

  it("propagates worker errors without restarting the worker", async () => {
    const { host, workers } = createHost();
    const failing = host.embedQuery("q");
    workers[0].emit("message", {
      id: workers[0].lastRequest().id,
      type: "error",
      message: "model files are missing",
    });
    await expect(failing).rejects.toThrow("model files are missing");

    const next = host.embedQuery("again");
    expect(workers).toHaveLength(1);
    workers[0].replyVectors(1);
    await expect(next).resolves.toHaveLength(EMBEDDING_DIMENSIONS);
    await host.dispose();
  });

  it("rejects invalid responses", async () => {
    const { host, workers } = createHost();
    const wrongDimensions = host.embedQuery("q");
    workers[0].emit("message", {
      id: workers[0].lastRequest().id,
      type: "vectors",
      vectors: [new Float32Array(3)],
    });
    await expect(wrongDimensions).rejects.toThrow(
      "Invalid embedding worker response",
    );

    const wrongCount = host.embedDocuments([
      { title: null, text: "a" },
      { title: null, text: "b" },
    ]);
    workers[0].replyVectors(1);
    await expect(wrongCount).rejects.toThrow("unexpected response");
    await host.dispose();
  });

  it("exits the worker after the idle timeout and respawns on demand", async () => {
    const { host, workers } = createHost({ idleTimeoutMs: 1_000 });
    const first = host.embedQuery("q");
    workers[0].replyVectors(1);
    await first;

    await vi.advanceTimersByTimeAsync(999);
    expect(workers[0].signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(workers[0].signals).toEqual(["SIGTERM"]);
    expect(workers[0].exited).toBe(true);
    expect(host.isWorkerRunning).toBe(false);

    const second = host.embedQuery("q");
    expect(workers).toHaveLength(2);
    workers[1].replyVectors(1);
    await second;
    await host.dispose();
  });

  it("does not exit while requests keep arriving", async () => {
    const { host, workers } = createHost({ idleTimeoutMs: 1_000 });
    for (let index = 0; index < 3; index++) {
      const result = host.embedQuery("q");
      workers[0].replyVectors(1);
      await result;
      await vi.advanceTimersByTimeAsync(600);
    }
    expect(workers).toHaveLength(1);
    expect(workers[0].signals).toEqual([]);
    await host.dispose();
  });

  it("rejects the in-flight request when the worker crashes and restarts for the next one", async () => {
    const { host, workers } = createHost();
    const crashed = host.embedDocuments([{ title: null, text: "a" }]);
    const queued = host.embedDocuments([{ title: null, text: "b" }]);
    workers[0].stderr.write("Segmentation fault\n");
    await new Promise((resolve) => process.nextTick(resolve));
    workers[0].exit(null, "SIGSEGV");
    await expect(crashed).rejects.toThrow(
      "Embedding worker exited (code null, signal SIGSEGV): Segmentation fault",
    );

    await vi.waitFor(() => expect(workers).toHaveLength(2));
    expect(workers[1].lastRequest()).toMatchObject({
      type: "embedDocuments",
      documents: [{ title: null, text: "b" }],
    });
    workers[1].replyVectors(1);
    await expect(queued).resolves.toHaveLength(1);
    await host.dispose();
  });

  it("kills a worker that exceeds the request timeout", async () => {
    const { host, workers } = createHost();
    const slow = host.embedQuery("q");
    const assertion = expect(slow).rejects.toThrow("timed out after 10000 ms");
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(workers[0].signals).toEqual(["SIGTERM"]);
    await host.dispose();
  });

  it("dispose kills the worker and rejects pending and future requests", async () => {
    const { host, workers } = createHost();
    const inFlight = host.embedQuery("a");
    const queued = host.embedDocuments([{ title: null, text: "b" }]);

    await host.dispose();

    await expect(inFlight).rejects.toThrow("disposed");
    await expect(queued).rejects.toThrow("disposed");
    expect(workers[0].signals).toEqual(["SIGTERM"]);
    expect(workers[0].exited).toBe(true);
    await expect(host.embedQuery("c")).rejects.toThrow("disposed");
    expect(workers).toHaveLength(1);
  });

  it("skips the worker for empty inputs", async () => {
    const { host, workers } = createHost();
    await expect(host.embedDocuments([])).resolves.toEqual([]);
    await expect(host.countTokens([])).resolves.toEqual([]);
    expect(workers).toHaveLength(0);
    await host.dispose();
  });
});
