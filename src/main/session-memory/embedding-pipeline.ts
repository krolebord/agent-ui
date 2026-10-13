import type { SessionMemoryEmbeddingState } from "@shared/session-memory";
import { defaultSessionMemoryEmbeddingState } from "@shared/session-memory";
import { createDisposable } from "@shared/utils";
import log from "../logger";
import {
  CHUNKER_VERSION,
  type ChunkerOptions,
  defaultChunkerOptions,
  planTurnChunks,
} from "./chunking";
import {
  DEFAULT_EMBEDDING_MAX_TOKENS,
  EMBEDDING_DIMENSIONS,
  type Embedder,
} from "./embedding/embedder";
import {
  type DownloadOptions,
  EMBEDDING_MODEL,
  type ModelFilesStatus,
} from "./embedding/model-files";
import {
  type ChunkQueueKey,
  clearTurnChunkingFailure,
  copyVectorFromTwin,
  type EmbeddingCounts,
  embeddingItemExists,
  findNextTurn,
  loadTurnToChunk,
  markTurnChunkingFailed,
  nextChunkToEmbed,
  nextSettleTime,
  readEmbeddingCounts,
  replaceTurnChunks,
  setChunkError,
  storeChunkVector,
} from "./store/chunks";
import type { SessionMemoryDatabase, SessionMemoryDb } from "./store/database";

export const SESSION_MEMORY_MODEL_ID = `${EMBEDDING_MODEL.repo}@${EMBEDDING_MODEL.revision.slice(0, 12)}:q8:${EMBEDDING_DIMENSIONS}d:${DEFAULT_EMBEDDING_MAX_TOKENS}t`;

/** Search can't run right now: disabled, unsupported, or the model isn't downloaded. */
export class SessionMemoryUnavailableError extends Error {
  override name = "SessionMemoryUnavailableError";
}

export interface ModelFiles {
  refresh(): Promise<ModelFilesStatus>;
  ensureDownloaded(options?: DownloadOptions): Promise<void>;
}

export interface PipelineTimers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface EmbeddingPipelineOptions {
  getDatabase: () => Promise<SessionMemoryDatabase>;
  createEmbedder: () => Embedder;
  modelFiles: ModelFiles;
  onStateChange: (state: SessionMemoryEmbeddingState) => void;
  modelId?: string;
  chunker?: ChunkerOptions;
  now?: () => number;
  timers?: PipelineTimers;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  yieldToEventLoop?: () => Promise<void>;
  /** Turns edited more recently than this (in an active conversation) wait. */
  settleMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  maxConsecutiveFailures?: number;
  /** Failures of one chunk or turn before it is skipped. */
  maxItemAttempts?: number;
  stateIntervalMs?: number;
  countsIntervalMs?: number;
}

const DEFAULT_SETTLE_MS = 5 * 60_000;
const DEFAULT_BACKOFF_BASE_MS = 2_000;
const DEFAULT_BACKOFF_MAX_MS = 2 * 60_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
const DEFAULT_MAX_ITEM_ATTEMPTS = 2;
const DEFAULT_STATE_INTERVAL_MS = 1_000;
const DEFAULT_COUNTS_INTERVAL_MS = 15_000;
const SETTLE_SLACK_MS = 1_000;
const RATE_WINDOW = 30;
const RATE_WINDOW_MS = 10 * 60_000;
/** Rough chars per chunk for turns not chunked yet; only feeds the progress total. */
const ESTIMATE_CHARS_PER_CHUNK = 4_000;

const defaultTimers: PipelineTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

const yieldWithSetImmediate = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type FailureMark = { kind: "chunk" | "turn"; id: number };
type AttemptResult = "ok" | "retry" | "stop";

const emptyCounts: EmbeddingCounts = {
  chunksEmbedded: 0,
  chunksPending: 0,
  chunksFailed: 0,
  turnsPending: 0,
  turnsSettling: 0,
  estimatedUnchunked: 0,
};

/**
 * Chunks and embeds indexed turns, newest first, one chunk per worker request
 * with each vector written as soon as it arrives. Failures back off
 * exponentially; an item that keeps failing is skipped, and a run of failures
 * across items stops the pipeline with an error until `retry`.
 */
export class SessionMemoryEmbeddingPipeline {
  readonly modelId: string;
  private readonly getDatabase: () => Promise<SessionMemoryDatabase>;
  private readonly createEmbedder: () => Embedder;
  private readonly modelFiles: ModelFiles;
  private readonly onStateChange: (state: SessionMemoryEmbeddingState) => void;
  private readonly chunker: ChunkerOptions;
  private readonly now: () => number;
  private readonly timers: PipelineTimers;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly yieldToEventLoop: () => Promise<void>;
  private readonly settleMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly maxItemAttempts: number;
  private readonly stateIntervalMs: number;
  private readonly countsIntervalMs: number;
  private readonly disposable = createDisposable({
    onError: (error) =>
      log.error("Session memory embedding teardown failed", { error }),
  });

  private enabled = false;
  private paused = false;
  private halted = false;
  private unsupported = false;
  private suspended = false;
  private controller: AbortController | null = null;
  private embedder: Embedder | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  private settleTimer: unknown = null;
  private flushTimer: unknown = null;
  private lastFlushAt = Number.NEGATIVE_INFINITY;
  private lastCountsAt = Number.NEGATIVE_INFINITY;
  private consecutiveFailures = 0;
  private readonly attempts = new Map<string, number>();
  private streakMarks: FailureMark[] = [];
  private recent: Array<{ at: number; tokens: number }> = [];
  private counts: EmbeddingCounts = { ...emptyCounts };
  private snapshot: SessionMemoryEmbeddingState = structuredClone(
    defaultSessionMemoryEmbeddingState,
  );

  constructor(options: EmbeddingPipelineOptions) {
    this.getDatabase = options.getDatabase;
    this.createEmbedder = options.createEmbedder;
    this.modelFiles = options.modelFiles;
    this.onStateChange = options.onStateChange;
    this.modelId = options.modelId ?? SESSION_MEMORY_MODEL_ID;
    this.chunker = options.chunker ?? defaultChunkerOptions;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? defaultTimers;
    this.sleep = options.sleep ?? abortableSleep;
    this.yieldToEventLoop = options.yieldToEventLoop ?? yieldWithSetImmediate;
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.maxConsecutiveFailures =
      options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
    this.maxItemAttempts = options.maxItemAttempts ?? DEFAULT_MAX_ITEM_ATTEMPTS;
    this.stateIntervalMs = options.stateIntervalMs ?? DEFAULT_STATE_INTERVAL_MS;
    this.countsIntervalMs =
      options.countsIntervalMs ?? DEFAULT_COUNTS_INTERVAL_MS;
    this.disposable.addDisposable(() => this.shutdown());
  }

  get idle(): Promise<void> {
    return (async () => {
      while (this.running) {
        await this.running;
      }
    })();
  }

  setEnabled(enabled: boolean): void {
    if (this.disposable.isDisposed || enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.controller = new AbortController();
      this.halted = false;
      this.consecutiveFailures = 0;
      this.update({ lastError: null });
      this.kick();
      return;
    }
    this.stop();
    this.update({ status: this.unsupported ? "unsupported" : "idle" });
  }

  setPaused(paused: boolean): void {
    if (this.disposable.isDisposed || paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      this.clearSettleTimer();
      if (this.enabled && !this.unsupported && !this.halted) {
        this.update({ status: "paused" });
      }
      return;
    }
    this.retry();
  }

  /** Clears a stopped-on-error state and starts over. */
  retry(): void {
    if (!this.enabled || this.disposable.isDisposed) return;
    this.halted = false;
    this.consecutiveFailures = 0;
    this.update({ lastError: null });
    this.kick();
  }

  /** Stops current work and waits for it to wind down; nothing runs again until `resume`. */
  async suspend(): Promise<void> {
    if (this.disposable.isDisposed) return;
    this.suspended = true;
    this.stop();
    await this.idle;
  }

  /** Starts over after `suspend`, with failure tracking reset, unless disabled or paused. */
  resume(): void {
    if (!this.suspended || this.disposable.isDisposed) return;
    this.suspended = false;
    this.halted = false;
    this.consecutiveFailures = 0;
    this.attempts.clear();
    this.streakMarks = [];
    this.counts = { ...emptyCounts };
    this.update({ lastError: null });
    if (!this.enabled) return;
    this.controller ??= new AbortController();
    this.kick();
  }

  /** Republishes counts after rows were removed outside the pipeline. */
  refreshCounts(): void {
    if (!this.enabled || this.suspended || this.disposable.isDisposed) return;
    void this.publishCounts();
  }

  kick(): void {
    if (
      !this.enabled ||
      this.suspended ||
      this.disposable.isDisposed ||
      this.unsupported
    ) {
      return;
    }
    if (this.paused || this.halted) {
      if (this.paused && !this.halted) this.update({ status: "paused" });
      void this.publishCounts();
      return;
    }
    if (this.running) {
      this.rerun = true;
      return;
    }
    const controller = this.controller;
    if (!controller) return;
    this.clearSettleTimer();
    const run = this.runLoop(controller.signal)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        log.error("Session memory embedding failed", error);
        this.halt(errorMessage(error));
      })
      .finally(() => {
        if (this.running === run) this.running = null;
        if (this.rerun) {
          this.rerun = false;
          this.kick();
        }
      });
    this.running = run;
  }

  async embedQuery(query: string): Promise<Float32Array> {
    if (!this.enabled) {
      throw new SessionMemoryUnavailableError("Session memory is disabled");
    }
    if (this.unsupported) {
      throw new SessionMemoryUnavailableError(
        "Session memory search is not supported here",
      );
    }
    const status = await this.modelFiles.refresh();
    if (status.state !== "ready") {
      throw new SessionMemoryUnavailableError(
        "The embedding model is not downloaded yet",
      );
    }
    return await this.getEmbedder().embedQuery(query);
  }

  dispose(): Promise<void> {
    return this.disposable.dispose();
  }

  private async shutdown(): Promise<void> {
    this.enabled = false;
    this.stop();
    await this.idle;
    if (this.flushTimer !== null) {
      this.timers.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private stop(): void {
    this.controller?.abort();
    this.controller = null;
    this.clearSettleTimer();
    this.recent = [];
    const embedder = this.embedder;
    this.embedder = null;
    if (embedder) {
      void embedder.dispose().catch((error: unknown) => {
        log.warn("Failed to stop the embedding worker", { error });
      });
    }
  }

  private getEmbedder(): Embedder {
    this.embedder ??= this.createEmbedder();
    return this.embedder;
  }

  private queueKey(): ChunkQueueKey {
    return {
      modelId: this.modelId,
      chunkerVersion: CHUNKER_VERSION,
      settledBefore: this.now() - this.settleMs,
    };
  }

  private canWork(signal: AbortSignal): boolean {
    return (
      !signal.aborted &&
      this.enabled &&
      !this.suspended &&
      !this.paused &&
      !this.halted &&
      !this.disposable.isDisposed
    );
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    const database = await this.getDatabase();
    if (!database.vectorSearch) {
      this.unsupported = true;
      this.update({
        status: "unsupported",
        lastError: "The sqlite-vec extension could not be loaded",
      });
      return;
    }
    if (!(await this.ensureModel(signal))) return;
    if (!this.canWork(signal)) {
      if (!signal.aborted && this.paused) this.update({ status: "paused" });
      return;
    }
    const { db } = database;
    this.recent = [];
    this.update({ status: "embedding" });
    await this.readCounts(db, true);

    while (this.canWork(signal)) {
      const next = await findNextTurn(db, this.queueKey());
      if (!next) break;
      if ((await this.processTurn(db, next, signal)) === "stop") return;
      await this.readCounts(db, false);
      await this.yieldToEventLoop();
    }
    if (signal.aborted || this.halted) return;

    await this.readCounts(db, true);
    this.update({ status: this.paused ? "paused" : "idle" });
    if (!this.paused) await this.scheduleSettleCheck(db);
  }

  private async ensureModel(signal: AbortSignal): Promise<boolean> {
    const status = await this.modelFiles.refresh();
    if (status.state === "ready") {
      this.update({ model: this.modelState("ready") });
      return true;
    }
    this.update({
      status: "downloading",
      model: this.modelState("downloading"),
    });
    try {
      await this.modelFiles.ensureDownloaded({
        signal,
        onProgress: (progress) => {
          this.update({
            model: {
              status: "downloading",
              bytesDone: progress.bytesDone,
              bytesTotal: progress.bytesTotal,
              error: null,
            },
          });
        },
      });
    } catch (error) {
      if (signal.aborted) return false;
      const message = errorMessage(error);
      log.error("Embedding model download failed", error);
      this.update({
        model: { ...this.modelState("error"), error: message },
      });
      this.halt(`Model download failed: ${message}`);
      return false;
    }
    this.update({ model: this.modelState("ready") });
    return true;
  }

  private modelState(
    status: SessionMemoryEmbeddingState["model"]["status"],
  ): SessionMemoryEmbeddingState["model"] {
    const previous = this.snapshot.model;
    return status === "ready"
      ? {
          status,
          bytesDone: previous.bytesTotal,
          bytesTotal: previous.bytesTotal,
          error: null,
        }
      : { ...previous, status, error: null };
  }

  private async processTurn(
    db: SessionMemoryDb,
    next: { turnId: number; needsChunking: boolean },
    signal: AbortSignal,
  ): Promise<AttemptResult> {
    if (next.needsChunking) {
      const turn = await loadTurnToChunk(db, next.turnId);
      if (!turn) return "ok";
      const base = {
        turn,
        modelId: this.modelId,
        chunkerVersion: CHUNKER_VERSION,
      };
      let replaced = false;
      const result = await this.attempt(
        db,
        { kind: "turn", id: turn.turnId },
        signal,
        async () => {
          const embedder = this.getEmbedder();
          const chunks = await planTurnChunks(
            turn,
            (texts) => embedder.countTokens(texts),
            this.chunker,
          );
          if (signal.aborted) return;
          const written = await replaceTurnChunks(db, {
            ...base,
            chunks,
            now: this.now(),
          });
          if (written) {
            replaced = true;
            this.counts.chunksPending += chunks.length - written.reused;
            this.counts.chunksEmbedded += written.reused;
          }
        },
        (error) =>
          markTurnChunkingFailed(db, { ...base, error, now: this.now() }),
      );
      if (result !== "ok" || !replaced) return result;
    }

    while (this.canWork(signal)) {
      const chunk = await nextChunkToEmbed(db, next.turnId);
      if (!chunk) break;
      const result = await this.attempt(
        db,
        { kind: "chunk", id: chunk.id },
        signal,
        async () => {
          if (await copyVectorFromTwin(db, chunk, this.modelId, this.now())) {
            this.counts.chunksEmbedded += 1;
            this.counts.chunksPending = Math.max(
              0,
              this.counts.chunksPending - 1,
            );
            return;
          }
          const [vector] = await this.getEmbedder().embedDocuments([
            { title: chunk.title, text: chunk.text },
          ]);
          if (signal.aborted) return;
          if (!vector) throw new Error("The embedder returned no vector");
          const at = this.now();
          if (await storeChunkVector(db, chunk, vector, at)) {
            this.recordEmbedded(at, chunk.tokenCount);
          }
        },
        (error) => setChunkError(db, chunk.id, error),
      );
      if (result !== "ok") return result;
    }
    return "ok";
  }

  private async attempt(
    db: SessionMemoryDb,
    item: FailureMark,
    signal: AbortSignal,
    work: () => Promise<void>,
    markFailed: (error: string) => Promise<void>,
  ): Promise<AttemptResult> {
    const key = `${item.kind}:${item.id}`;
    try {
      await work();
      this.attempts.delete(key);
      // Chunking only tokenizes, so it says little about whether embedding works.
      if (item.kind === "chunk") {
        this.consecutiveFailures = 0;
        this.streakMarks = [];
      }
      return "ok";
    } catch (error) {
      if (signal.aborted || this.disposable.isDisposed) return "stop";
      if (!(await embeddingItemExists(db, item))) {
        this.attempts.delete(key);
        return "ok";
      }
      const message = errorMessage(error);
      this.consecutiveFailures += 1;
      log.warn("Session memory embedding step failed", {
        item: key,
        consecutiveFailures: this.consecutiveFailures,
        error: message,
      });
      this.update({ lastError: message });

      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        // Everything is failing, so the skipped items were probably fine.
        await this.revertMarks(db, this.streakMarks);
        this.streakMarks = [];
        this.attempts.clear();
        this.halt(message);
        return "stop";
      }

      const attempts = (this.attempts.get(key) ?? 0) + 1;
      if (attempts >= this.maxItemAttempts) {
        this.attempts.delete(key);
        await markFailed(message);
        this.streakMarks.push(item);
        this.counts.chunksFailed += item.kind === "chunk" ? 1 : 0;
      } else {
        this.attempts.set(key, attempts);
      }

      await this.sleep(
        Math.min(
          this.backoffBaseMs * 2 ** (this.consecutiveFailures - 1),
          this.backoffMaxMs,
        ),
        signal,
      );
      return signal.aborted ? "stop" : "retry";
    }
  }

  private async revertMarks(
    db: SessionMemoryDb,
    marks: readonly FailureMark[],
  ): Promise<void> {
    for (const mark of marks) {
      if (mark.kind === "chunk") {
        await setChunkError(db, mark.id, null);
      } else {
        await clearTurnChunkingFailure(db, mark.id);
      }
    }
  }

  private halt(message: string): void {
    this.halted = true;
    this.update({ status: "error", lastError: message });
  }

  private recordEmbedded(at: number, tokens: number): void {
    this.counts.chunksEmbedded += 1;
    this.counts.chunksPending = Math.max(0, this.counts.chunksPending - 1);
    this.recent.push({ at, tokens });
    while (
      this.recent.length > RATE_WINDOW ||
      (this.recent.length > 0 && this.recent[0].at < at - RATE_WINDOW_MS)
    ) {
      this.recent.shift();
    }
    this.update({ lastEmbeddedAt: at });
  }

  private async readCounts(db: SessionMemoryDb, force: boolean): Promise<void> {
    const at = this.now();
    if (force || at - this.lastCountsAt >= this.countsIntervalMs) {
      this.lastCountsAt = at;
      this.counts = await readEmbeddingCounts(db, this.queueKey(), {
        charsPerChunk: ESTIMATE_CHARS_PER_CHUNK,
        maxChunksPerTurn: this.chunker.maxHeadChunks + 1,
      });
    }
    this.update({});
  }

  private async publishCounts(): Promise<void> {
    try {
      const database = await this.getDatabase();
      await this.readCounts(database.db, true);
    } catch (error) {
      log.warn("Failed to read session memory embedding counts", error);
    }
  }

  private async scheduleSettleCheck(db: SessionMemoryDb): Promise<void> {
    const eligibleAt = await nextSettleTime(db, this.queueKey(), this.settleMs);
    this.clearSettleTimer();
    if (eligibleAt === null || !this.enabled || this.paused) return;
    this.settleTimer = this.timers.setTimeout(
      () => {
        this.settleTimer = null;
        this.kick();
      },
      Math.max(0, eligibleAt - this.now()) + SETTLE_SLACK_MS,
    );
  }

  private clearSettleTimer(): void {
    if (this.settleTimer !== null) {
      this.timers.clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
  }

  private update(patch: Partial<SessionMemoryEmbeddingState>): void {
    Object.assign(this.snapshot, patch);
    if (this.flushTimer !== null || this.disposable.isDisposed) return;
    const wait = this.lastFlushAt + this.stateIntervalMs - this.now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.flushTimer = this.timers.setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, wait);
  }

  private flush(): void {
    this.lastFlushAt = this.now();
    const counts = this.counts;
    const remaining = counts.chunksPending + counts.estimatedUnchunked;
    let chunksPerMinute: number | null = null;
    let tokensPerSecond: number | null = null;
    if (this.snapshot.status === "embedding" && this.recent.length >= 2) {
      const first = this.recent[0];
      const last = this.recent[this.recent.length - 1];
      const span = last.at - first.at;
      if (span > 0) {
        const tokens = this.recent
          .slice(1)
          .reduce((sum, entry) => sum + entry.tokens, 0);
        chunksPerMinute = ((this.recent.length - 1) * 60_000) / span;
        tokensPerSecond = (tokens * 1_000) / span;
      }
    }
    Object.assign(this.snapshot, {
      chunksEmbedded: counts.chunksEmbedded,
      chunksTotal: counts.chunksEmbedded + counts.chunksFailed + remaining,
      chunksFailed: counts.chunksFailed,
      turnsPending: counts.turnsPending,
      turnsSettling: counts.turnsSettling,
      chunksPerMinute,
      tokensPerSecond,
      etaMs:
        chunksPerMinute && chunksPerMinute > 0
          ? Math.round((remaining / chunksPerMinute) * 60_000)
          : null,
    });
    this.onStateChange(structuredClone(this.snapshot));
  }
}
