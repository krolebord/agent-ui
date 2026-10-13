import type { SessionMemoryEmbeddingState } from "@shared/session-memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../../src/main/logger", () => ({ default: loggerMocks }));

import type { EmbeddingDocument } from "../../../src/main/session-memory/embedding/embedder";
import { FakeEmbedder } from "../../../src/main/session-memory/embedding/fake-embedder";
import {
  type EmbeddingPipelineOptions,
  type ModelFiles,
  SessionMemoryEmbeddingPipeline,
} from "../../../src/main/session-memory/embedding-pipeline";
import type { ParsedTurn } from "../../../src/main/session-memory/parsers/types";
import type { SessionMemoryDatabase } from "../../../src/main/session-memory/store/database";
import {
  clearIndex,
  forgetConversation,
} from "../../../src/main/session-memory/store/forgetting";
import { applyParseOutcome } from "../../../src/main/session-memory/store/index-writer";
import { getConversation } from "../../../src/main/session-memory/store/queries";
import {
  createTempDatabase,
  makeConversation,
  makeSource,
  makeTurn,
  outcomeOf,
} from "./store/fixtures";

const MINUTE = 60_000;
const SETTLE_MS = 5 * MINUTE;
const BASE_TIME = 1_000 * MINUTE;

class ManualTimers {
  private nextId = 1;
  readonly pending = new Map<number, { callback: () => void; ms: number }>();

  setTimeout = (callback: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.pending.set(id, { callback, ms });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  delays(): number[] {
    return [...this.pending.values()].map((timer) => timer.ms);
  }

  fireAll(): void {
    const timers = [...this.pending.values()];
    this.pending.clear();
    for (const timer of timers) timer.callback();
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class ScriptedEmbedder extends FakeEmbedder {
  failWhen: ((document: EmbeddingDocument) => boolean) | null = null;
  gate: Promise<void> | null = null;
  onEmbed: (() => void) | null = null;
  countGate: Promise<void> | null = null;
  onCount: (() => void) | null = null;
  failCount = false;

  override async countTokens(texts: string[]): Promise<number[]> {
    this.onCount?.();
    if (this.countGate) await this.countGate;
    if (this.failCount) throw new Error("tokenizer crashed");
    return await super.countTokens(texts);
  }

  override async embedDocuments(
    documents: EmbeddingDocument[],
  ): Promise<Float32Array[]> {
    this.onEmbed?.();
    if (this.gate) await this.gate;
    if (this.disposed) throw new Error("Embedder is disposed");
    if (documents.some((document) => this.failWhen?.(document))) {
      this.calls.push({ type: "embedDocuments", documents });
      throw new Error("worker exited (code 1)");
    }
    return await super.embedDocuments(documents);
  }
}

describe("SessionMemoryEmbeddingPipeline", () => {
  let database: SessionMemoryDatabase;
  let cleanup: () => Promise<void>;
  let clock: { now: number };
  let timers: ManualTimers;
  let sleeps: number[];
  let embedders: ScriptedEmbedder[];
  let configure: (embedder: ScriptedEmbedder) => void;
  let states: SessionMemoryEmbeddingState[];
  let pipelines: SessionMemoryEmbeddingPipeline[];

  beforeEach(async () => {
    ({ database, cleanup } = await createTempDatabase());
    clock = { now: BASE_TIME };
    timers = new ManualTimers();
    sleeps = [];
    embedders = [];
    configure = () => {};
    states = [];
    pipelines = [];
  });

  afterEach(async () => {
    for (const pipeline of pipelines) await pipeline.dispose();
    await cleanup();
  });

  function createPipeline(
    overrides: Partial<EmbeddingPipelineOptions> = {},
  ): SessionMemoryEmbeddingPipeline {
    const pipeline = new SessionMemoryEmbeddingPipeline({
      getDatabase: async () => database,
      createEmbedder: () => {
        const embedder = new ScriptedEmbedder();
        configure(embedder);
        embedders.push(embedder);
        return embedder;
      },
      modelFiles: {
        refresh: async () => ({ state: "ready" }),
        ensureDownloaded: async () => {},
      },
      onStateChange: (state) => states.push(state),
      now: () => clock.now,
      timers,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      yieldToEventLoop: async () => {},
      settleMs: SETTLE_MS,
      backoffBaseMs: 1_000,
      backoffMaxMs: 4_000,
      stateIntervalMs: 0,
      countsIntervalMs: 0,
      ...overrides,
    });
    pipelines.push(pipeline);
    return pipeline;
  }

  async function run(pipeline: SessionMemoryEmbeddingPipeline) {
    pipeline.setEnabled(true);
    await pipeline.idle;
  }

  function lastState(): SessionMemoryEmbeddingState {
    const state = states.at(-1);
    if (!state) throw new Error("No state published");
    return state;
  }

  function embeddedTexts(): string[] {
    return embedders.flatMap((embedder) =>
      embedder.calls.flatMap((call) =>
        call.type === "embedDocuments"
          ? call.documents.map((document) => document.text)
          : [],
      ),
    );
  }

  async function index(
    nativeId: string,
    options: {
      turns: ParsedTurn[];
      title?: string | null;
      updatedAtMs?: number;
      now?: number;
    },
  ) {
    const source = makeSource("claude", `/c/${nativeId}.jsonl`);
    await applyParseOutcome(database.db, {
      source,
      outcome: outcomeOf(
        makeConversation(source, {
          nativeId,
          title: options.title ?? null,
          startedAtMs: options.turns[0]?.startedAtMs ?? 0,
          updatedAtMs: options.updatedAtMs ?? BASE_TIME - 60 * MINUTE,
          turns: options.turns,
        }),
      ),
      links: { projectPath: null, agentUiSessionId: null },
      parserVersion: 1,
      now: options.now ?? BASE_TIME - 60 * MINUTE,
    });
  }

  async function chunkRows() {
    return await database.db
      .selectFrom("chunks")
      .innerJoin("turns", "turns.id", "chunks.turn_id")
      .select([
        "chunks.id",
        "chunks.text",
        "chunks.vector",
        "chunks.error",
        "chunks.model_id",
        "turns.user_text",
      ])
      .orderBy("chunks.id")
      .execute();
  }

  it("embeds the newest turns first and reports progress", async () => {
    await index("old", {
      turns: [makeTurn(0, { userText: "old one", startedAtMs: 1_000 })],
    });
    await index("new", {
      turns: [
        makeTurn(0, { userText: "new one", startedAtMs: 5_000 }),
        makeTurn(1, { userText: "new two", startedAtMs: 6_000 }),
      ],
    });

    await run(createPipeline());

    expect(embeddedTexts()).toEqual([
      "User: new two\n\nAssistant: answer 1",
      "User: new one\n\nAssistant: answer 0",
      "User: old one\n\nAssistant: answer 0",
    ]);
    const rows = await chunkRows();
    expect(rows.every((row) => row.vector?.byteLength === 768 * 4)).toBe(true);
    expect(lastState()).toMatchObject({
      status: "idle",
      chunksEmbedded: 3,
      chunksTotal: 3,
      turnsPending: 0,
      turnsSettling: 0,
      lastEmbeddedAt: BASE_TIME,
    });
    expect(states.some((state) => state.status === "embedding")).toBe(true);
  });

  it("waits for recently changed turns of active conversations to settle", async () => {
    await index("active", {
      turns: [
        makeTurn(0, { userText: "settled", startedAtMs: 1_000 }),
        makeTurn(1, { userText: "typing", startedAtMs: 2_000 }),
      ],
      updatedAtMs: BASE_TIME - MINUTE,
      now: BASE_TIME - 2 * MINUTE,
    });
    // Only the second turn's content changed recently.
    await index("active", {
      turns: [
        makeTurn(0, { userText: "settled", startedAtMs: 1_000 }),
        makeTurn(1, { userText: "typing more", startedAtMs: 2_000 }),
      ],
      updatedAtMs: BASE_TIME - MINUTE,
      now: BASE_TIME - MINUTE,
    });
    await database.db
      .updateTable("turns")
      .set({ content_updated_at: BASE_TIME - 60 * MINUTE })
      .where("ordinal", "=", 0)
      .execute();

    const pipeline = createPipeline();
    await run(pipeline);

    expect(embeddedTexts()).toEqual(["User: settled\n\nAssistant: answer 0"]);
    expect(lastState()).toMatchObject({ turnsPending: 0, turnsSettling: 1 });
    expect(timers.delays()).toEqual([4 * MINUTE + 1_000]);

    clock.now += 5 * MINUTE;
    timers.fireAll();
    await pipeline.idle;

    expect(embeddedTexts()).toHaveLength(2);
    expect(lastState()).toMatchObject({ turnsSettling: 0, chunksEmbedded: 2 });
  });

  it("re-embeds when content or title changes and drops stale chunks", async () => {
    await index("conv", {
      turns: [makeTurn(0, { userText: "first" }), makeTurn(1)],
      title: "Old title",
    });
    const pipeline = createPipeline();
    await run(pipeline);
    expect(embeddedTexts()).toHaveLength(2);

    await index("conv", {
      turns: [makeTurn(0, { userText: "first, edited" })],
      title: "Old title",
    });
    pipeline.kick();
    await pipeline.idle;

    expect(embeddedTexts()).toHaveLength(3);
    expect((await chunkRows()).map((row) => row.text)).toEqual([
      "User: first, edited\n\nAssistant: answer 0",
    ]);

    await index("conv", {
      turns: [makeTurn(0, { userText: "first, edited" })],
      title: "New title",
    });
    pipeline.kick();
    await pipeline.idle;

    const lastCall = embedders.at(-1)?.calls.at(-1);
    expect(lastCall).toMatchObject({
      type: "embedDocuments",
      documents: [{ title: "New title" }],
    });
    expect(await chunkRows()).toHaveLength(1);
  });

  it("re-embeds everything for a new model id and reuses vectors for identical prompts", async () => {
    await index("a", { turns: [makeTurn(0, { userText: "same" })] });
    await index("b", { turns: [makeTurn(0, { userText: "same" })] });
    await run(createPipeline({ modelId: "model-1" }));

    expect(embeddedTexts()).toHaveLength(1);
    expect((await chunkRows()).every((row) => row.vector !== null)).toBe(true);

    await run(createPipeline({ modelId: "model-2" }));

    expect(embeddedTexts()).toHaveLength(2);
    const rows = await chunkRows();
    expect(rows.map((row) => row.model_id)).toEqual(["model-2", "model-2"]);
    expect(rows.every((row) => row.vector !== null)).toBe(true);
  });

  it("pauses after the current chunk and resumes", async () => {
    await index("conv", {
      turns: [makeTurn(0), makeTurn(1), makeTurn(2)],
    });
    const gate = deferred();
    configure = (embedder) => {
      embedder.gate = gate.promise;
    };
    const pipeline = createPipeline();
    pipeline.setEnabled(true);
    await vi.waitFor(() => expect(embedders).toHaveLength(1));

    pipeline.setPaused(true);
    gate.resolve();
    await pipeline.idle;

    expect(embeddedTexts()).toHaveLength(1);
    expect(lastState()).toMatchObject({
      status: "paused",
      chunksEmbedded: 1,
      chunksTotal: 3,
      turnsPending: 2,
    });

    pipeline.setPaused(false);
    await pipeline.idle;

    expect(embeddedTexts()).toHaveLength(3);
    expect(lastState().status).toBe("idle");
  });

  it("backs off on repeated failures, then stops with an error and keeps items retryable", async () => {
    await index("conv", { turns: [makeTurn(0), makeTurn(1), makeTurn(2)] });
    configure = (embedder) => {
      embedder.failWhen = () => true;
    };
    const pipeline = createPipeline();
    await run(pipeline);

    expect(sleeps).toEqual([1_000, 2_000, 4_000, 4_000]);
    expect(lastState()).toMatchObject({
      status: "error",
      lastError: "worker exited (code 1)",
    });
    expect((await chunkRows()).every((row) => row.error === null)).toBe(true);

    configure = () => {};
    for (const embedder of embedders) embedder.failWhen = null;
    pipeline.retry();
    await pipeline.idle;

    expect(lastState()).toMatchObject({
      status: "idle",
      chunksEmbedded: 3,
      lastError: null,
    });
  });

  it("skips a chunk that keeps failing without blocking the queue", async () => {
    await index("conv", {
      turns: [
        makeTurn(0, { startedAtMs: 1_000 }),
        makeTurn(1, { userText: "poison", startedAtMs: 2_000 }),
        makeTurn(2, { startedAtMs: 3_000 }),
      ],
    });
    configure = (embedder) => {
      embedder.failWhen = (document) => document.text.includes("poison");
    };
    await run(createPipeline());

    const rows = await chunkRows();
    expect(
      rows.map((row) => [row.user_text, row.vector !== null, row.error]),
    ).toEqual([
      ["question 2", true, null],
      ["poison", false, "worker exited (code 1)"],
      ["question 0", true, null],
    ]);
    expect(lastState()).toMatchObject({
      status: "idle",
      chunksEmbedded: 2,
      chunksFailed: 1,
    });
    expect(sleeps).toEqual([1_000, 2_000]);
  });

  it("stops and releases the worker when disabled mid-run", async () => {
    await index("conv", { turns: [makeTurn(0), makeTurn(1)] });
    const gate = deferred();
    configure = (embedder) => {
      embedder.gate = gate.promise;
    };
    const pipeline = createPipeline();
    pipeline.setEnabled(true);
    await vi.waitFor(() => expect(embedders).toHaveLength(1));
    await vi.waitFor(() =>
      expect(
        embedders[0]?.calls.some((call) => call.type === "countTokens"),
      ).toBe(true),
    );

    pipeline.setEnabled(false);
    gate.resolve();
    await pipeline.idle;

    expect(embedders[0]?.disposed).toBe(true);
    expect(
      (await chunkRows()).every((row) => row.vector === null && !row.error),
    ).toBe(true);
    expect(lastState().status).toBe("idle");
    expect(sleeps).toEqual([]);
  });

  it("downloads the model before embedding and surfaces download errors", async () => {
    await index("conv", { turns: [makeTurn(0)] });
    let ready = false;
    const modelFiles: ModelFiles = {
      refresh: async () => (ready ? { state: "ready" } : { state: "missing" }),
      ensureDownloaded: vi.fn(async (options) => {
        options?.onProgress?.({
          file: "model",
          fileBytes: 50,
          fileTotal: 100,
          bytesDone: 50,
          bytesTotal: 100,
        });
        if (!ready) throw new Error("HTTP 503");
      }),
    };
    const pipeline = createPipeline({ modelFiles });
    await run(pipeline);

    expect(
      states.some(
        (state) =>
          state.status === "downloading" &&
          state.model.status === "downloading" &&
          state.model.bytesDone === 50,
      ),
    ).toBe(true);
    expect(lastState()).toMatchObject({
      status: "error",
      model: { status: "error", error: "HTTP 503" },
      lastError: "Model download failed: HTTP 503",
    });
    expect(embeddedTexts()).toEqual([]);

    ready = true;
    pipeline.retry();
    await pipeline.idle;

    expect(lastState()).toMatchObject({
      status: "idle",
      model: { status: "ready", error: null },
      chunksEmbedded: 1,
    });
  });

  it("reports unsupported when sqlite-vec is unavailable", async () => {
    const pipeline = createPipeline({
      getDatabase: async () =>
        ({ ...database, vectorSearch: false }) as SessionMemoryDatabase,
    });
    await run(pipeline);

    expect(lastState().status).toBe("unsupported");
    await expect(pipeline.embedQuery("x")).rejects.toThrow("not supported");
  });
  async function forget(nativeId: string) {
    const conversation = await getConversation(database.db, {
      agent: "claude",
      nativeId,
    });
    if (!conversation) throw new Error(`${nativeId} is not indexed`);
    await forgetConversation(database.db, {
      id: conversation.id,
      now: BASE_TIME,
    });
  }

  it("moves on without a failure when a chunk is forgotten mid-embed", async () => {
    await index("secret", { turns: [makeTurn(0), makeTurn(1)] });
    await index("kept", {
      turns: [makeTurn(0, { userText: "kept", startedAtMs: 1 })],
    });
    const gate = deferred();
    const entered = deferred();
    configure = (embedder) => {
      embedder.gate = gate.promise;
      embedder.onEmbed = () => entered.resolve();
    };
    const pipeline = createPipeline();
    pipeline.setEnabled(true);
    await entered.promise;

    await forget("secret");
    gate.resolve();
    await pipeline.idle;

    const rows = await chunkRows();
    expect(rows.map((row) => [row.user_text, row.vector !== null])).toEqual([
      ["kept", true],
    ]);
    expect(lastState()).toMatchObject({
      status: "idle",
      chunksEmbedded: 1,
      chunksFailed: 0,
      lastError: null,
    });
    expect(sleeps).toEqual([]);
  });

  it("does not count a failure when a turn is forgotten while it is chunked", async () => {
    await index("secret", { turns: [makeTurn(0)] });
    const gate = deferred();
    const entered = deferred();
    configure = (embedder) => {
      embedder.countGate = gate.promise;
      embedder.onCount = () => entered.resolve();
      embedder.failCount = true;
    };
    const pipeline = createPipeline();
    pipeline.setEnabled(true);
    await entered.promise;

    await forget("secret");
    gate.resolve();
    await pipeline.idle;

    expect(sleeps).toEqual([]);
    expect(lastState()).toMatchObject({
      status: "idle",
      chunksFailed: 0,
      lastError: null,
    });
    expect(
      await database.db.selectFrom("turn_chunk_state").selectAll().execute(),
    ).toEqual([]);
  });

  it("suspends in-flight work and starts over on resume, honoring pause", async () => {
    await index("old", { turns: [makeTurn(0), makeTurn(1)] });
    const gate = deferred();
    const entered = deferred();
    configure = (embedder) => {
      embedder.gate = gate.promise;
      embedder.onEmbed = () => entered.resolve();
    };
    const pipeline = createPipeline();
    pipeline.setEnabled(true);
    await entered.promise;

    const suspended = pipeline.suspend();
    gate.resolve();
    await suspended;
    expect(embedders[0]?.disposed).toBe(true);

    await clearIndex(database.db);
    configure = () => {};
    await index("new", { turns: [makeTurn(0, { userText: "fresh" })] });
    pipeline.kick();
    pipeline.setPaused(true);
    await pipeline.idle;
    expect(embeddedTexts()).toEqual([]);

    pipeline.resume();
    await vi.waitFor(() =>
      expect(lastState()).toMatchObject({ status: "paused", turnsPending: 1 }),
    );

    pipeline.setPaused(false);
    await pipeline.idle;
    expect(embeddedTexts()).toEqual(["User: fresh\n\nAssistant: answer 0"]);
    expect(lastState()).toMatchObject({ status: "idle", chunksEmbedded: 1 });
  });
});
