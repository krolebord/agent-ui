import { access } from "node:fs/promises";
import path from "node:path";
import { ORPCError } from "@orpc/server";
import { defineServiceState } from "@shared/service-state";
import {
  defaultSessionMemoryState,
  type SessionMemoryAgent,
  type SessionMemoryClearIndexPreview,
  type SessionMemoryConversationListInput,
  type SessionMemoryConversationPage,
  type SessionMemoryConversationSearchInput,
  type SessionMemoryConversationSearchResult,
  type SessionMemoryForgottenConversation,
  type SessionMemorySearchHit,
  type SessionMemorySearchInput,
  type SessionMemoryState,
  sessionMemoryAgents,
  sessionMemoryRelations,
  sessionMemorySearchGroupings,
} from "@shared/session-memory";
import { z } from "zod";
import { resolveTranscriptRoots } from "../agent-transcripts/roots";
import type { AppSettingsState } from "../app-settings";
import log from "../logger";
import { procedure } from "../orpc";
import type { ProjectState } from "../project-service";
import type { SessionServiceState } from "../sessions/state";
import {
  type EmbeddingPipelineOptions,
  SessionMemoryEmbeddingPipeline,
  SessionMemoryUnavailableError,
} from "./embedding-pipeline";
import { createConversationLinker, type GitDirInspector } from "./linking";
import {
  ClaudeForkFinder,
  createTextGenerationRules,
  discoverTranscriptSources,
  type ParseOutcome,
  parseTranscriptSource,
  resolveHeadlessInstallRoot,
  TRANSCRIPT_PARSER_VERSION,
  type TranscriptSource,
} from "./parsers";
import { searchConversations } from "./search-conversations";
import {
  SESSION_MEMORY_DATABASE_FILENAME,
  SessionMemoryDatabase,
  type SessionMemoryDb,
} from "./store/database";
import {
  clearIndex,
  forgetConversation,
  listForgottenConversations,
  readClearIndexPreview,
  restoreForgottenConversation,
  vacuumDatabase,
} from "./store/forgetting";
import { readIndexCounts } from "./store/index-writer";
import { listConversationSummaries } from "./store/queries";
import { searchChunks } from "./store/search";
import { runSessionMemorySync } from "./sync";

export const defineSessionMemoryState = () =>
  defineServiceState({
    key: "sessionMemory" as const,
    defaults: defaultSessionMemoryState,
  });

export type SessionMemoryServiceState = ReturnType<
  typeof defineSessionMemoryState
>;

interface Timers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const defaultTimers: Timers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SessionMemoryServiceOptions {
  userDataPath: string;
  state: SessionMemoryServiceState;
  appSettingsState: AppSettingsState;
  projectsState: ProjectState;
  sessionsState: SessionServiceState;
  openDatabase?: () => Promise<SessionMemoryDatabase>;
  /** Whether a database file exists that a disabled service could still clear. */
  databaseExists?: () => Promise<boolean>;
  discover?: () => Promise<TranscriptSource[]>;
  parse?: (source: TranscriptSource) => Promise<ParseOutcome>;
  inspectGitDir?: GitDirInspector;
  parserVersion?: number;
  now?: () => number;
  timers?: Timers;
  yieldToEventLoop?: () => Promise<void>;
  initialDelayMs?: number;
  intervalMs?: number;
  progressIntervalMs?: number;
  /** Omitted where the embedding worker cannot run; search then reports unsupported. */
  embedding?: Omit<EmbeddingPipelineOptions, "getDatabase" | "onStateChange">;
}

export const SESSION_MEMORY_SEARCH_DEFAULT_LIMIT = 10;
export const SESSION_MEMORY_SEARCH_MAX_LIMIT = 50;

const DEFAULT_INITIAL_DELAY_MS = 30_000;
const DEFAULT_INTERVAL_MS = 10 * 60_000;
const DEFAULT_PROGRESS_INTERVAL_MS = 1_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SessionMemoryNotFoundError extends Error {
  override name = "SessionMemoryNotFoundError";
}

export class SessionMemoryService {
  private readonly state: SessionMemoryServiceState;
  private readonly appSettingsState: AppSettingsState;
  private readonly projectsState: ProjectState;
  private readonly sessionsState: SessionServiceState;
  private readonly openDatabase: () => Promise<SessionMemoryDatabase>;
  private readonly databaseExists: () => Promise<boolean>;
  private readonly discover: () => Promise<TranscriptSource[]>;
  private readonly parse: (source: TranscriptSource) => Promise<ParseOutcome>;
  private readonly inspectGitDir: GitDirInspector | undefined;
  private readonly parserVersion: number;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly yieldToEventLoop: (() => Promise<void>) | undefined;
  private readonly initialDelayMs: number;
  private readonly intervalMs: number;
  private readonly progressIntervalMs: number;
  private readonly pipeline: SessionMemoryEmbeddingPipeline | null;

  private started = false;
  private disposed = false;
  private enabled = false;
  private database: Promise<SessionMemoryDatabase> | null = null;
  private syncTimer: unknown = null;
  private currentSync: Promise<void> | null = null;
  private queuedSync: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private clearing: Promise<void> | null = null;

  constructor(options: SessionMemoryServiceOptions) {
    this.state = options.state;
    this.appSettingsState = options.appSettingsState;
    this.projectsState = options.projectsState;
    this.sessionsState = options.sessionsState;
    this.openDatabase =
      options.openDatabase ??
      (() => SessionMemoryDatabase.create(options.userDataPath));
    this.databaseExists =
      options.databaseExists ??
      (() =>
        access(
          path.join(options.userDataPath, SESSION_MEMORY_DATABASE_FILENAME),
        ).then(
          () => true,
          () => false,
        ));
    this.discover =
      options.discover ??
      (() => discoverTranscriptSources(resolveTranscriptRoots()));
    if (options.parse) {
      this.parse = options.parse;
    } else {
      const context = {
        textGeneration: createTextGenerationRules({
          userDataPath: options.userDataPath,
          installRoots: [resolveHeadlessInstallRoot()],
        }),
        claudeForks: new ClaudeForkFinder(),
      };
      this.parse = (source) => parseTranscriptSource(source, context);
    }
    this.inspectGitDir = options.inspectGitDir;
    this.parserVersion = options.parserVersion ?? TRANSCRIPT_PARSER_VERSION;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? defaultTimers;
    this.yieldToEventLoop = options.yieldToEventLoop;
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.progressIntervalMs =
      options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    this.pipeline = options.embedding
      ? new SessionMemoryEmbeddingPipeline({
          now: this.now,
          ...options.embedding,
          getDatabase: () => this.getIndexDatabase(),
          onStateChange: (embedding) => {
            this.state.updateState((state) => {
              state.embedding = embedding;
            });
          },
        })
      : null;
    if (!this.pipeline) {
      this.state.updateState((state) => {
        state.embedding.status = "unsupported";
      });
    }
  }

  start(): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    this.appSettingsState.eventTarget.addEventListener(
      "state-update",
      this.handleSettingsUpdate,
    );
    this.applyEnabled();
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.appSettingsState.eventTarget.removeEventListener(
      "state-update",
      this.handleSettingsUpdate,
    );
    this.clearTimers();
    this.abortController?.abort();
    await this.pipeline?.dispose();
    await this.clearing?.catch(() => undefined);
    await this.queuedSync;
    await this.currentSync;
    const database = this.database;
    this.database = null;
    if (database) {
      await database.then(
        (opened) => opened.close(),
        () => undefined,
      );
    }
  }

  /** Lazily opens the index database; it stays open until dispose. */
  async getDatabase(): Promise<SessionMemoryDb> {
    return (await this.getIndexDatabase()).db;
  }

  private getIndexDatabase(): Promise<SessionMemoryDatabase> {
    if (this.disposed) {
      return Promise.reject(new Error("Session memory service is disposed"));
    }
    this.database ??= this.openDatabase().catch((error: unknown) => {
      this.database = null;
      throw error;
    });
    return this.database;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getState(): Readonly<SessionMemoryState> {
    return this.state.state;
  }

  /**
   * Ranks embedded chunks by similarity to `query`. Turns that are not
   * embedded yet are simply absent, so this works during the backfill.
   */
  async searchSessionMemory(
    input: SessionMemorySearchInput,
  ): Promise<SessionMemorySearchHit[]> {
    if (!this.enabled) {
      throw new SessionMemoryUnavailableError("Session memory is disabled");
    }
    const database = await this.getIndexDatabase();
    if (!this.pipeline || !database.vectorSearch) {
      throw new SessionMemoryUnavailableError(
        "Session memory search is not supported here",
      );
    }
    const { query, limit, groupBy, ...filters } = input;
    const vector = await this.pipeline.embedQuery(query);
    return await searchChunks(database.db, {
      ...filters,
      vector,
      modelId: this.pipeline.modelId,
      groupBy,
      limit: Math.min(
        Math.max(1, Math.trunc(limit ?? SESSION_MEMORY_SEARCH_DEFAULT_LIMIT)),
        SESSION_MEMORY_SEARCH_MAX_LIMIT,
      ),
    });
  }

  /** Semantic search for people browsing the index; nothing is excluded. */
  async searchConversations(
    input: SessionMemoryConversationSearchInput,
  ): Promise<SessionMemoryConversationSearchResult> {
    const conversations = await searchConversations(
      {
        getDatabase: () => this.getDatabase(),
        searchSessionMemory: (search) => this.searchSessionMemory(search),
      },
      { ...input, limit: SESSION_MEMORY_SEARCH_DEFAULT_LIMIT },
    );
    return { conversations };
  }

  retryEmbedding(): void {
    this.pipeline?.retry();
  }

  private async getEnabledDatabase(): Promise<SessionMemoryDb> {
    if (!this.enabled) {
      throw new SessionMemoryUnavailableError("Session memory is disabled");
    }
    return await this.getDatabase();
  }

  async listConversations(
    input: SessionMemoryConversationListInput,
  ): Promise<SessionMemoryConversationPage> {
    return await listConversationSummaries(
      await this.getEnabledDatabase(),
      input,
    );
  }

  async listForgotten(): Promise<SessionMemoryForgottenConversation[]> {
    return await listForgottenConversations(await this.getEnabledDatabase());
  }

  /**
   * Deletes a conversation and its subagents from the index and keeps sync
   * from storing them again. A sync or embedding pass touching it meanwhile
   * sees the rows vanish and moves on.
   */
  async forgetConversation(id: number): Promise<void> {
    const db = await this.getEnabledDatabase();
    const result = await forgetConversation(db, { id, now: this.now() });
    if (!result) {
      throw new SessionMemoryNotFoundError(
        "The conversation is not in the index.",
      );
    }
    log.info("Forgot session memory conversation", {
      agent: result.agent,
      conversations: result.deletedConversationIds.length,
    });
    await this.refreshCounts();
    this.pipeline?.refreshCounts();
  }

  async restoreForgotten(input: {
    agent: SessionMemoryAgent;
    nativeId: string;
  }): Promise<void> {
    const db = await this.getEnabledDatabase();
    if (!(await restoreForgottenConversation(db, input))) {
      throw new SessionMemoryNotFoundError(
        "The conversation is not forgotten.",
      );
    }
    void this.requestSync();
  }

  /** Works while disabled too, as long as there is a database to clear. */
  async getClearIndexPreview(): Promise<SessionMemoryClearIndexPreview> {
    if (!(await this.hasDatabase())) {
      return { conversations: 0, conversationsWithoutTranscript: 0 };
    }
    return await readClearIndexPreview(await this.getDatabase());
  }

  /**
   * Deletes every indexed source, conversation, turn and chunk but keeps the
   * forgotten list, then rebuilds from the transcripts on disk. An in-flight
   * sync is aborted and the embedding pipeline suspended until the wipe is done.
   */
  clearIndex(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("Session memory service is disposed"));
    }
    this.clearing ??= this.runClear().finally(() => {
      this.clearing = null;
    });
    return this.clearing;
  }

  private async hasDatabase(): Promise<boolean> {
    return (
      this.enabled || this.database !== null || (await this.databaseExists())
    );
  }

  private async runClear(): Promise<void> {
    this.clearTimers();
    this.abortController?.abort();
    const suspended = this.pipeline?.suspend();
    while (this.currentSync || this.queuedSync) {
      await this.queuedSync;
      await this.currentSync;
    }
    await suspended;
    try {
      if (!(await this.hasDatabase())) {
        return;
      }
      const db = await this.getDatabase();
      const startedAt = this.now();
      await clearIndex(db);
      const clearedAt = this.now();
      await vacuumDatabase(db);
      log.info("Cleared the session memory index", {
        deleteMs: clearedAt - startedAt,
        vacuumMs: this.now() - clearedAt,
      });
      const counts = await readIndexCounts(db);
      this.state.updateState((state) => {
        state.counts = counts;
        state.lastSyncFinishedAt = null;
        state.lastSyncDurationMs = null;
      });
    } finally {
      this.pipeline?.resume();
      void this.requestSync();
    }
  }

  /** Runs a sync, or joins the follow-up of one already running. */
  requestSync(): Promise<void> {
    if (!this.enabled || this.disposed) {
      return Promise.resolve();
    }
    if (this.clearing) {
      return this.clearing.then(
        () => this.requestSync(),
        () => this.requestSync(),
      );
    }
    if (this.queuedSync) {
      return this.queuedSync;
    }
    if (this.currentSync) {
      const queued = this.currentSync.then(() => {
        if (this.queuedSync === queued) {
          this.queuedSync = null;
        }
        return this.startSync();
      });
      this.queuedSync = queued;
      return queued;
    }
    return this.startSync();
  }

  private readonly handleSettingsUpdate = () => {
    this.applyEnabled();
  };

  private applyEnabled(): void {
    if (this.disposed) {
      return;
    }
    const { enabled, embeddingPaused } =
      this.appSettingsState.state.sessionMemory;
    this.pipeline?.setPaused(embeddingPaused);
    if (enabled === this.enabled) {
      return;
    }
    this.enabled = enabled;
    this.state.updateState((state) => {
      state.enabled = enabled;
    });

    this.pipeline?.setEnabled(enabled);
    if (enabled) {
      this.scheduleSync(this.initialDelayMs);
      void this.refreshCounts();
      return;
    }

    this.clearTimers();
    this.abortController?.abort();
  }

  private async refreshCounts(): Promise<void> {
    try {
      const counts = await readIndexCounts(await this.getDatabase());
      if (!this.disposed) {
        this.state.updateState((state) => {
          state.counts = counts;
        });
      }
    } catch (error) {
      log.warn("Failed to read session memory counts", error);
    }
  }

  private clearTimers(): void {
    if (this.syncTimer !== null) {
      this.timers.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private scheduleSync(delayMs: number): void {
    if (this.syncTimer !== null) {
      this.timers.clearTimeout(this.syncTimer);
    }
    this.syncTimer = this.timers.setTimeout(() => {
      this.syncTimer = null;
      void this.requestSync();
    }, delayMs);
  }

  private startSync(): Promise<void> {
    if (!this.enabled || this.disposed || this.clearing) {
      return Promise.resolve();
    }
    if (this.syncTimer !== null) {
      this.timers.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    const run = this.runSync().finally(() => {
      if (this.currentSync === run) {
        this.currentSync = null;
      }
      if (this.enabled && !this.disposed && this.queuedSync === null) {
        this.scheduleSync(this.intervalMs);
      }
    });
    this.currentSync = run;
    return run;
  }

  private async runSync(): Promise<void> {
    const controller = new AbortController();
    this.abortController = controller;
    const startedAt = this.now();
    let lastProgressAt = Number.NEGATIVE_INFINITY;

    this.state.updateState((state) => {
      state.syncStatus = "syncing";
      state.lastSyncStartedAt = startedAt;
      state.progress = { done: 0, total: 0 };
    });

    try {
      const db = await this.getDatabase();
      const result = await runSessionMemorySync({
        db,
        discover: this.discover,
        parse: this.parse,
        linker: createConversationLinker({
          projects: this.projectsState.state,
          sessions: this.sessionsState.state,
          inspectGitDir: this.inspectGitDir,
        }),
        parserVersion: this.parserVersion,
        now: this.now,
        signal: controller.signal,
        yieldToEventLoop: this.yieldToEventLoop,
        onProgress: (progress) => {
          const at = this.now();
          if (
            at - lastProgressAt < this.progressIntervalMs &&
            progress.done < progress.total
          ) {
            return;
          }
          lastProgressAt = at;
          this.state.updateState((state) => {
            state.progress = progress;
          });
        },
      });
      const counts = await readIndexCounts(db);
      const finishedAt = this.now();
      if (result.processed > 0 || result.newlyMissing > 0) {
        log.info("Session memory sync finished", {
          ...result,
          durationMs: finishedAt - startedAt,
        });
      }
      this.state.updateState((state) => {
        state.syncStatus = "idle";
        state.lastSyncFinishedAt = finishedAt;
        state.lastSyncDurationMs = finishedAt - startedAt;
        state.lastError = null;
        state.progress = null;
        state.counts = counts;
      });
      this.pipeline?.kick();
    } catch (error) {
      log.error("Session memory sync failed", error);
      const finishedAt = this.now();
      this.state.updateState((state) => {
        state.syncStatus = "error";
        state.lastSyncFinishedAt = finishedAt;
        state.lastSyncDurationMs = finishedAt - startedAt;
        state.lastError = errorMessage(error);
        state.progress = null;
      });
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }
}

const oneOrMany = <T extends z.ZodType>(schema: T) =>
  z.union([schema, z.array(schema)]);

export const sessionMemorySearchInputSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  agent: oneOrMany(z.enum(sessionMemoryAgents)).optional(),
  projectPath: z.string().min(1).optional(),
  cwdPrefix: z.string().min(1).optional(),
  activeFrom: z.number().optional(),
  activeTo: z.number().optional(),
  relation: oneOrMany(z.enum(sessionMemoryRelations)).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SESSION_MEMORY_SEARCH_MAX_LIMIT)
    .optional(),
  groupBy: z.enum(["chunk", "conversation"]).optional(),
});

export const sessionMemoryConversationSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  agent: z.enum(sessionMemoryAgents).optional(),
  projectPath: z.string().min(1).optional(),
  groupBy: z.enum(sessionMemorySearchGroupings).optional(),
});

export const SESSION_MEMORY_LIST_MAX_LIMIT = 100;

export const sessionMemoryListConversationsInputSchema = z.object({
  query: z.string().trim().max(500).optional(),
  agent: z.enum(sessionMemoryAgents).optional(),
  projectPath: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(SESSION_MEMORY_LIST_MAX_LIMIT),
  offset: z.number().int().min(0),
});

async function toOrpcErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SessionMemoryUnavailableError) {
      throw new ORPCError("PRECONDITION_FAILED", { message: error.message });
    }
    if (error instanceof SessionMemoryNotFoundError) {
      throw new ORPCError("NOT_FOUND", { message: error.message });
    }
    throw error;
  }
}

export const sessionMemoryRouter = {
  setEnabled: procedure
    .input(z.object({ enabled: z.boolean() }))
    .handler(async ({ input, context }) => {
      context.appSettingsState.updateState((state) => {
        state.sessionMemory.enabled = input.enabled;
      });
    }),
  syncNow: procedure.handler(async ({ context }) => {
    if (!context.sessionMemory.isEnabled()) {
      throw new ORPCError("PRECONDITION_FAILED", {
        message: "Session memory is disabled.",
      });
    }
    await context.sessionMemory.requestSync();
  }),
  setEmbeddingPaused: procedure
    .input(z.object({ paused: z.boolean() }))
    .handler(async ({ input, context }) => {
      context.appSettingsState.updateState((state) => {
        state.sessionMemory.embeddingPaused = input.paused;
      });
    }),
  retryEmbedding: procedure.handler(async ({ context }) => {
    context.sessionMemory.retryEmbedding();
  }),
  search: procedure
    .input(sessionMemorySearchInputSchema)
    .handler(({ input, context }) =>
      toOrpcErrors(() => context.sessionMemory.searchSessionMemory(input)),
    ),
  searchConversations: procedure
    .input(sessionMemoryConversationSearchInputSchema)
    .handler(({ input, context }) =>
      toOrpcErrors(async () => {
        try {
          return await context.sessionMemory.searchConversations(input);
        } catch (error) {
          if (
            error instanceof SessionMemoryUnavailableError ||
            error instanceof ORPCError
          ) {
            throw error;
          }
          log.error("Session memory search failed", error);
          throw new ORPCError("INTERNAL_SERVER_ERROR", {
            message: `Semantic search failed: ${errorMessage(error)}`,
          });
        }
      }),
    ),
  listConversations: procedure
    .input(sessionMemoryListConversationsInputSchema)
    .handler(({ input, context }) =>
      toOrpcErrors(() => context.sessionMemory.listConversations(input)),
    ),
  forgetConversation: procedure
    .input(z.object({ id: z.number().int().positive() }))
    .handler(({ input, context }) =>
      toOrpcErrors(() => context.sessionMemory.forgetConversation(input.id)),
    ),
  listForgotten: procedure.handler(({ context }) =>
    toOrpcErrors(() => context.sessionMemory.listForgotten()),
  ),
  restoreForgotten: procedure
    .input(
      z.object({
        agent: z.enum(sessionMemoryAgents),
        nativeId: z.string().min(1).max(500),
      }),
    )
    .handler(({ input, context }) =>
      toOrpcErrors(() => context.sessionMemory.restoreForgotten(input)),
    ),
  getClearIndexPreview: procedure.handler(({ context }) =>
    context.sessionMemory.getClearIndexPreview(),
  ),
  clearIndex: procedure.handler(({ context }) =>
    context.sessionMemory.clearIndex(),
  ),
};
