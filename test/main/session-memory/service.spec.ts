import { call } from "@orpc/server";
import type { ClaudeProject } from "@shared/claude-types";
import { defineServiceState } from "@shared/service-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../../src/main/logger", () => ({ default: loggerMocks }));

import { defineAppSettingsState } from "../../../src/main/app-settings";
import type { Services } from "../../../src/main/create-services";
import { FakeEmbedder } from "../../../src/main/session-memory/embedding/fake-embedder";
import type {
  ParseOutcome,
  TranscriptSource,
} from "../../../src/main/session-memory/parsers/types";
import {
  defineSessionMemoryState,
  SessionMemoryService,
  sessionMemoryRouter,
} from "../../../src/main/session-memory/service";
import type { SessionMemoryDatabase } from "../../../src/main/session-memory/store/database";
import type { Session } from "../../../src/main/sessions/state";
import {
  createTempDatabase,
  makeConversation,
  makeSource,
  makeTurn,
  outcomeOf,
} from "./store/fixtures";

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

  fire(ms: number): void {
    for (const [id, timer] of this.pending) {
      if (timer.ms === ms) {
        this.pending.delete(id);
        timer.callback();
        return;
      }
    }
    throw new Error(`No timer pending for ${ms}ms`);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("SessionMemoryService", () => {
  let database: SessionMemoryDatabase;
  let cleanup: () => Promise<void>;
  let timers: ManualTimers;
  let appSettingsState: ReturnType<typeof defineAppSettingsState>;
  let sessionsState: ReturnType<
    typeof defineServiceState<"sessions", Record<string, Session>>
  >;
  let state: ReturnType<typeof defineSessionMemoryState>;
  let sources: TranscriptSource[];
  let discover: ReturnType<typeof vi.fn<() => Promise<TranscriptSource[]>>>;
  let openDatabase: ReturnType<
    typeof vi.fn<() => Promise<SessionMemoryDatabase>>
  >;
  let service: SessionMemoryService;

  beforeEach(async () => {
    ({ database, cleanup } = await createTempDatabase());
    timers = new ManualTimers();
    appSettingsState = defineAppSettingsState();
    sessionsState = defineServiceState({
      key: "sessions",
      defaults: {} as Record<string, Session>,
    });
    state = defineSessionMemoryState();
    const source = makeSource("claude", "/c/abc.jsonl");
    sources = [source];
    discover = vi.fn(async () => sources);
    openDatabase = vi.fn(async () => database);
    service = new SessionMemoryService({
      userDataPath: "/unused",
      state,
      appSettingsState,
      projectsState: defineServiceState({
        key: "projects" as const,
        defaults: [] as ClaudeProject[],
      }),
      sessionsState,
      openDatabase,
      discover,
      parse: async (parsed): Promise<ParseOutcome> =>
        outcomeOf(makeConversation(parsed)),
      inspectGitDir: async () => ({ kind: "none" }),
      now: () => 1_000,
      timers,
      yieldToEventLoop: async () => {},
      initialDelayMs: 30_000,
      intervalMs: 600_000,
    });
  });

  afterEach(async () => {
    await service.dispose();
    await cleanup();
  });

  function setEnabled(enabled: boolean): void {
    appSettingsState.updateState((settings) => {
      settings.sessionMemory.enabled = enabled;
    });
  }

  it("stays idle and leaves the database closed while disabled", async () => {
    service.start();

    expect(state.state.enabled).toBe(false);
    expect(timers.delays()).toEqual([]);
    await service.requestSync();
    expect(discover).not.toHaveBeenCalled();
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it("syncs after the initial delay once enabled and then rescans periodically", async () => {
    service.start();
    setEnabled(true);

    expect(state.state.enabled).toBe(true);
    expect(timers.delays()).toEqual([30_000]);

    timers.fire(30_000);
    await vi.waitFor(() => expect(state.state.lastSyncFinishedAt).toBe(1_000));

    expect(state.state).toMatchObject({
      syncStatus: "idle",
      lastSyncDurationMs: 0,
      lastError: null,
      progress: null,
      counts: {
        sources: { indexed: 1, excluded: 0, empty: 0, failed: 0, missing: 0 },
        conversations: { claude: 1, codex: 0, cursor: 0 },
        turns: 2,
      },
    });
    expect(timers.delays()).toEqual([600_000]);

    timers.fire(600_000);
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
  });

  it("coalesces sync requests made while a sync is running into one follow-up", async () => {
    const gate = deferred();
    discover.mockImplementationOnce(async () => {
      await gate.promise;
      return sources;
    });
    service.start();
    setEnabled(true);

    const first = service.requestSync();
    const second = service.requestSync();
    const third = service.requestSync();
    expect(second).toBe(third);
    await flush();
    expect(discover).toHaveBeenCalledTimes(1);

    gate.resolve();
    await Promise.all([first, second, third]);

    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("stops syncing when disabled and keeps the database", async () => {
    const gate = deferred();
    discover.mockImplementationOnce(async () => {
      await gate.promise;
      return [
        makeSource("claude", "/c/a.jsonl", "1:1", 3),
        makeSource("claude", "/c/b.jsonl", "1:1", 2),
      ];
    });
    service.start();
    setEnabled(true);

    const running = service.requestSync();
    await flush();
    setEnabled(false);
    gate.resolve();
    await running;

    expect(state.state.enabled).toBe(false);
    expect(state.state.counts?.sources.indexed).toBe(0);
    expect(timers.delays()).toEqual([]);

    setEnabled(true);
    expect(timers.delays()).toEqual([30_000]);
    expect(openDatabase).toHaveBeenCalledTimes(1);
  });

  it("reports embeddings as unsupported without an embedder", () => {
    expect(state.state.embedding.status).toBe("unsupported");
  });

  it("reports sync errors in state", async () => {
    discover.mockRejectedValueOnce(new Error("disk gone"));
    service.start();
    setEnabled(true);

    await service.requestSync();

    expect(state.state).toMatchObject({
      syncStatus: "error",
      lastError: "disk gone",
      progress: null,
    });
  });

  it("toggles the persisted flag and rejects manual syncs while disabled", async () => {
    service.start();
    const context = {
      appSettingsState,
      sessionMemory: service,
    } as unknown as Services;

    await expect(
      call(sessionMemoryRouter.syncNow, undefined, { context }),
    ).rejects.toThrow("Session memory is disabled.");

    await call(sessionMemoryRouter.setEnabled, { enabled: true }, { context });
    expect(appSettingsState.state.sessionMemory.enabled).toBe(true);
    expect(state.state.enabled).toBe(true);

    await call(sessionMemoryRouter.syncNow, undefined, { context });
    expect(discover).toHaveBeenCalledTimes(1);
  });
});

describe("SessionMemoryService embeddings", () => {
  let database: SessionMemoryDatabase;
  let cleanup: () => Promise<void>;
  let appSettingsState: ReturnType<typeof defineAppSettingsState>;
  let state: ReturnType<typeof defineSessionMemoryState>;
  let service: SessionMemoryService;
  let context: Services;
  let modelReady: boolean;

  beforeEach(async () => {
    ({ database, cleanup } = await createTempDatabase());
    appSettingsState = defineAppSettingsState();
    state = defineSessionMemoryState();
    modelReady = true;
    service = new SessionMemoryService({
      userDataPath: "/unused",
      state,
      appSettingsState,
      projectsState: defineServiceState({
        key: "projects" as const,
        defaults: [] as ClaudeProject[],
      }),
      sessionsState: defineServiceState({
        key: "sessions",
        defaults: {} as Record<string, Session>,
      }),
      openDatabase: async () => database,
      discover: async () => [makeSource("claude", "/c/abc.jsonl")],
      parse: async (parsed): Promise<ParseOutcome> =>
        outcomeOf(
          makeConversation(parsed, {
            turns: [
              makeTurn(0, { userText: "how do we rotate the api keys" }),
              makeTurn(1, { userText: "fix the flaky websocket test" }),
            ],
          }),
        ),
      inspectGitDir: async () => ({ kind: "none" }),
      now: () => 1_000,
      timers: new ManualTimers(),
      yieldToEventLoop: async () => {},
      embedding: {
        createEmbedder: () => new FakeEmbedder(),
        modelFiles: {
          refresh: async () => ({ state: modelReady ? "ready" : "missing" }),
          ensureDownloaded: async () => {},
        },
        timers: new ManualTimers(),
        yieldToEventLoop: async () => {},
        settleMs: 0,
        stateIntervalMs: 0,
        countsIntervalMs: 0,
      },
    });
    context = {
      appSettingsState,
      sessionMemory: service,
    } as unknown as Services;
    service.start();
  });

  afterEach(async () => {
    await service.dispose();
    await cleanup();
  });

  it("embeds after a sync and searches what is embedded", async () => {
    await expect(
      call(sessionMemoryRouter.search, { query: "api keys" }, { context }),
    ).rejects.toThrow("Session memory is disabled");

    await call(sessionMemoryRouter.setEnabled, { enabled: true }, { context });
    await service.requestSync();
    await vi.waitFor(() =>
      expect(state.state.embedding).toMatchObject({
        status: "idle",
        chunksEmbedded: 2,
      }),
    );

    const hits = await call(
      sessionMemoryRouter.search,
      { query: "websocket test", limit: 1 },
      { context },
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      turn: { ordinal: 1 },
      conversation: { agent: "claude", nativeId: "abc" },
    });
    expect(hits[0].chunk.text).toContain("fix the flaky websocket test");
  });

  it("persists the paused flag and resumes from it", async () => {
    await call(sessionMemoryRouter.setEnabled, { enabled: true }, { context });
    await call(
      sessionMemoryRouter.setEmbeddingPaused,
      { paused: true },
      { context },
    );
    expect(appSettingsState.state.sessionMemory.embeddingPaused).toBe(true);

    await service.requestSync();
    await vi.waitFor(() =>
      expect(state.state.embedding).toMatchObject({
        status: "paused",
        turnsPending: 2,
        chunksEmbedded: 0,
      }),
    );

    await call(
      sessionMemoryRouter.setEmbeddingPaused,
      { paused: false },
      { context },
    );
    await vi.waitFor(() =>
      expect(state.state.embedding).toMatchObject({
        status: "idle",
        chunksEmbedded: 2,
      }),
    );
  });

  it("searches conversations for the Memory page", async () => {
    await expect(
      call(
        sessionMemoryRouter.searchConversations,
        { query: "api keys" },
        { context },
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Session memory is disabled",
    });

    await call(sessionMemoryRouter.setEnabled, { enabled: true }, { context });
    await service.requestSync();
    await vi.waitFor(() =>
      expect(state.state.embedding).toMatchObject({
        status: "idle",
        chunksEmbedded: 2,
      }),
    );

    const result = await call(
      sessionMemoryRouter.searchConversations,
      { query: "  websocket test  ", agent: "claude", groupBy: "turn" },
      { context },
    );
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0]?.conversation).toMatchObject({
      agent: "claude",
      nativeId: "abc",
      turnCount: 2,
      transcriptOnDisk: true,
    });
    expect(result.conversations[0]?.turns[0]).toMatchObject({ ordinal: 1 });
    expect(result.conversations[0]?.turns[0]?.snippet).toContain(
      "fix the flaky websocket test",
    );

    const filtered = await call(
      sessionMemoryRouter.searchConversations,
      { query: "websocket test", projectPath: "/elsewhere" },
      { context },
    );
    expect(filtered.conversations).toEqual([]);

    const embedQuery = vi
      .spyOn(FakeEmbedder.prototype, "embedQuery")
      .mockRejectedValueOnce(new Error("Embedding worker exited"));
    await expect(
      call(
        sessionMemoryRouter.searchConversations,
        { query: "websocket test" },
        { context },
      ),
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Semantic search failed: Embedding worker exited",
    });
    embedQuery.mockRestore();

    modelReady = false;
    await expect(
      call(
        sessionMemoryRouter.searchConversations,
        { query: "websocket test" },
        { context },
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "The embedding model is not downloaded yet",
    });
  });

  it("validates search input", async () => {
    await call(sessionMemoryRouter.setEnabled, { enabled: true }, { context });
    for (const input of [
      { query: "   " },
      { query: "x".repeat(2_001) },
      { query: "ok", groupBy: "chunk" },
      { query: "ok", agent: "gemini" },
      { query: "ok", projectPath: "" },
    ]) {
      await expect(
        call(
          sessionMemoryRouter.searchConversations,
          input as { query: string },
          { context },
        ),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });
});

describe("SessionMemoryService without embedding support", () => {
  it("reports that semantic search is unsupported", async () => {
    const { database, cleanup } = await createTempDatabase();
    const appSettingsState = defineAppSettingsState();
    const state = defineSessionMemoryState();
    const service = new SessionMemoryService({
      userDataPath: "/unused",
      state,
      appSettingsState,
      projectsState: defineServiceState({
        key: "projects" as const,
        defaults: [] as ClaudeProject[],
      }),
      sessionsState: defineServiceState({
        key: "sessions",
        defaults: {} as Record<string, Session>,
      }),
      openDatabase: async () => database,
      discover: async () => [],
      inspectGitDir: async () => ({ kind: "none" }),
      timers: new ManualTimers(),
      yieldToEventLoop: async () => {},
    });
    const context = {
      appSettingsState,
      sessionMemory: service,
    } as unknown as Services;
    service.start();
    try {
      await call(
        sessionMemoryRouter.setEnabled,
        { enabled: true },
        { context },
      );
      expect(state.state.embedding.status).toBe("unsupported");
      await expect(
        call(
          sessionMemoryRouter.searchConversations,
          { query: "websocket test" },
          { context },
        ),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: "Session memory search is not supported here",
      });
    } finally {
      await service.dispose();
      await cleanup();
    }
  });
});

class GatedEmbedder extends FakeEmbedder {
  constructor(
    private readonly gate: { promise: Promise<void> },
    private readonly onEmbed: () => void,
  ) {
    super();
  }

  override async embedDocuments(
    documents: { title: string | null; text: string }[],
  ) {
    this.onEmbed();
    await this.gate.promise;
    return await super.embedDocuments(documents);
  }
}

describe("SessionMemoryService index management", () => {
  let database: SessionMemoryDatabase;
  let cleanup: () => Promise<void>;
  let appSettingsState: ReturnType<typeof defineAppSettingsState>;
  let state: ReturnType<typeof defineSessionMemoryState>;
  let sources: TranscriptSource[];
  let parse: ReturnType<
    typeof vi.fn<(source: TranscriptSource) => Promise<ParseOutcome>>
  >;
  let embedGate: ReturnType<typeof deferred>;
  let embedStarted: ReturnType<typeof deferred>;
  let embedders: GatedEmbedder[];
  let databaseExists: boolean;
  let service: SessionMemoryService;
  let context: Services;

  beforeEach(async () => {
    ({ database, cleanup } = await createTempDatabase());
    appSettingsState = defineAppSettingsState();
    state = defineSessionMemoryState();
    sources = [
      makeSource("claude", "/c/keep.jsonl", "1:1", 2),
      makeSource("claude", "/c/secret.jsonl", "1:1", 1),
    ];
    parse = vi.fn(async (source: TranscriptSource) =>
      outcomeOf(makeConversation(source)),
    );
    embedGate = deferred();
    embedGate.resolve();
    embedStarted = deferred();
    embedders = [];
    databaseExists = false;
    service = new SessionMemoryService({
      userDataPath: "/unused",
      state,
      appSettingsState,
      projectsState: defineServiceState({
        key: "projects" as const,
        defaults: [] as ClaudeProject[],
      }),
      sessionsState: defineServiceState({
        key: "sessions",
        defaults: {} as Record<string, Session>,
      }),
      openDatabase: async () => database,
      databaseExists: async () => databaseExists,
      discover: async () => sources,
      parse,
      inspectGitDir: async () => ({ kind: "none" }),
      now: () => 1_000,
      timers: new ManualTimers(),
      yieldToEventLoop: async () => {},
      embedding: {
        createEmbedder: () => {
          const embedder = new GatedEmbedder(embedGate, () =>
            embedStarted.resolve(),
          );
          embedders.push(embedder);
          return embedder;
        },
        modelFiles: {
          refresh: async () => ({ state: "ready" }),
          ensureDownloaded: async () => {},
        },
        timers: new ManualTimers(),
        yieldToEventLoop: async () => {},
        settleMs: 0,
        stateIntervalMs: 0,
        countsIntervalMs: 0,
      },
    });
    context = {
      appSettingsState,
      sessionMemory: service,
    } as unknown as Services;
    service.start();
  });

  afterEach(async () => {
    embedGate.resolve();
    await service.dispose();
    await cleanup();
  });

  async function enableAndSync() {
    await call(sessionMemoryRouter.setEnabled, { enabled: true }, { context });
    await service.requestSync();
  }

  async function conversationId(nativeId: string): Promise<number> {
    const page = await call(
      sessionMemoryRouter.listConversations,
      { limit: 50, offset: 0 },
      { context },
    );
    const found = page.conversations.find(
      (conversation) => conversation.nativeId === nativeId,
    );
    if (!found) throw new Error(`${nativeId} is not listed`);
    return found.id;
  }

  async function indexedNativeIds(): Promise<string[]> {
    const page = await call(
      sessionMemoryRouter.listConversations,
      { limit: 50, offset: 0 },
      { context },
    );
    return page.conversations.map((conversation) => conversation.nativeId);
  }

  it("requires session memory to be enabled for browsing and forgetting", async () => {
    await expect(
      call(
        sessionMemoryRouter.listConversations,
        { limit: 10, offset: 0 },
        { context },
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      call(sessionMemoryRouter.forgetConversation, { id: 1 }, { context }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      call(
        sessionMemoryRouter.listConversations,
        { limit: 0, offset: 0 },
        { context },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("forgets a conversation, updates counts, and restores it on request", async () => {
    await enableAndSync();
    expect(state.state.counts?.conversations.claude).toBe(2);

    await call(
      sessionMemoryRouter.forgetConversation,
      { id: await conversationId("secret") },
      { context },
    );

    expect(await indexedNativeIds()).toEqual(["keep"]);
    expect(state.state.counts).toMatchObject({
      conversations: { claude: 1 },
      sources: { indexed: 1, forgotten: 1 },
    });
    await expect(
      call(sessionMemoryRouter.forgetConversation, { id: 9_999 }, { context }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await service.requestSync();
    expect(await indexedNativeIds()).toEqual(["keep"]);
    expect(
      await call(sessionMemoryRouter.listForgotten, undefined, { context }),
    ).toEqual([
      {
        agent: "claude",
        nativeId: "secret",
        label: "question 0",
        forgottenAt: 1_000,
      },
    ]);

    await call(
      sessionMemoryRouter.restoreForgotten,
      { agent: "claude", nativeId: "secret" },
      { context },
    );
    await vi.waitFor(async () =>
      expect((await indexedNativeIds()).sort()).toEqual(["keep", "secret"]),
    );
    expect(
      await call(sessionMemoryRouter.listForgotten, undefined, { context }),
    ).toEqual([]);
    await expect(
      call(
        sessionMemoryRouter.restoreForgotten,
        { agent: "claude", nativeId: "secret" },
        { context },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("clears during a sync, keeps forgotten entries, then rebuilds and re-embeds", async () => {
    await enableAndSync();
    await vi.waitFor(() =>
      expect(state.state.embedding).toMatchObject({
        status: "idle",
        chunksEmbedded: 4,
      }),
    );
    await call(
      sessionMemoryRouter.forgetConversation,
      { id: await conversationId("secret") },
      { context },
    );
    expect(
      await call(sessionMemoryRouter.getClearIndexPreview, undefined, {
        context,
      }),
    ).toEqual({ conversations: 1, conversationsWithoutTranscript: 0 });

    sources = [
      makeSource("claude", "/c/keep.jsonl", "2:2", 3),
      makeSource("claude", "/c/secret.jsonl", "1:1", 1),
      makeSource("claude", "/c/new.jsonl", "1:1", 2),
    ];
    embedGate = deferred();
    embedStarted = deferred();
    const parseGate = deferred();
    const parseStarted = deferred();
    const events: string[] = [];
    parse.mockImplementation(async (source) => {
      events.push(`parse ${source.path}`);
      parseStarted.resolve();
      await parseGate.promise;
      return outcomeOf(makeConversation(source));
    });
    const syncing = service.requestSync();
    await parseStarted.promise;

    const clearing = call(sessionMemoryRouter.clearIndex, undefined, {
      context,
    });
    await flush();
    events.push("release");
    parseGate.resolve();
    await syncing;
    await clearing;
    events.push("cleared");

    expect(
      await database.db.selectFrom("chunks").selectAll().execute(),
    ).toEqual([]);
    await vi.waitFor(() =>
      expect(state.state).toMatchObject({
        syncStatus: "idle",
        counts: { conversations: { claude: 2 } },
      }),
    );
    expect(events).toEqual([
      "parse /c/keep.jsonl",
      "release",
      "cleared",
      "parse /c/keep.jsonl",
      "parse /c/new.jsonl",
      "parse /c/secret.jsonl",
    ]);
    expect((await indexedNativeIds()).sort()).toEqual(["keep", "new"]);
    expect(
      await database.db
        .selectFrom("sources")
        .select("status")
        .where("path", "=", "/c/secret.jsonl")
        .executeTakeFirst(),
    ).toEqual({ status: "forgotten" });
    expect(
      await call(sessionMemoryRouter.listForgotten, undefined, { context }),
    ).toHaveLength(1);

    await embedStarted.promise;
    embedGate.resolve();
    await vi.waitFor(() =>
      expect(state.state.embedding).toMatchObject({
        status: "idle",
        chunksEmbedded: 4,
        chunksFailed: 0,
        lastError: null,
      }),
    );
  });

  it("stops an embedding run in progress before clearing", async () => {
    embedGate = deferred();
    await enableAndSync();
    await embedStarted.promise;

    const clearing = call(sessionMemoryRouter.clearIndex, undefined, {
      context,
    });
    await vi.waitFor(() => expect(embedders[0]?.disposed).toBe(true));
    embedGate.resolve();
    await clearing;

    expect(
      await database.db
        .selectFrom("chunks")
        .select("id")
        .where("vector", "is not", null)
        .execute(),
    ).toEqual([]);
    await vi.waitFor(() =>
      expect(state.state.embedding).toMatchObject({
        status: "idle",
        chunksEmbedded: 4,
        lastError: null,
      }),
    );
  });

  it("clears an existing database while disabled without syncing", async () => {
    await enableAndSync();
    await call(sessionMemoryRouter.setEnabled, { enabled: false }, { context });
    parse.mockClear();
    databaseExists = true;

    expect(
      await call(sessionMemoryRouter.getClearIndexPreview, undefined, {
        context,
      }),
    ).toEqual({ conversations: 2, conversationsWithoutTranscript: 0 });
    await call(sessionMemoryRouter.clearIndex, undefined, { context });

    expect(state.state.counts?.conversations.claude).toBe(0);
    expect(parse).not.toHaveBeenCalled();
    expect(
      await database.db.selectFrom("conversations").selectAll().execute(),
    ).toEqual([]);
  });
});
