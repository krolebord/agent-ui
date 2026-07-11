import { call } from "@orpc/server";
import {
  type CodexFastMode,
  type CodexModelReasoningEffort,
  type CodexPermissionMode,
  codexFastModeSchema,
  codexModelReasoningEffortSchema,
} from "@shared/codex-types";
import type { TerminalEvent } from "@shared/terminal-types";
import { z } from "zod";
import { CodexAppServerProcess } from "../codex-app-server-runtime";
import {
  type CodexAppServerCollabAgentStatus,
  type CodexAppServerSessionState,
  type CodexAppServerSubagentUpdate,
  CodexAppServerTracker,
} from "../codex-app-server-tracker";
import { buildCodexArgs } from "../codex-cli";
import { getCodexUsage } from "../codex-usage";
import type { McpRequestContext } from "../mcp/session-token";
import { procedure } from "../orpc";
import { TerminalManager } from "../terminal-manager";
import type { TerminalSessionStatus } from "../terminal-session";
import type { TitleGenerationService } from "../title-generation-service";
import {
  commonSessionSchema,
  generateUniqueSessionId,
  type SessionStatus,
  sessionStatusSchema,
} from "./common";
import type { SessionServiceState } from "./state";

const DEFAULT_CODEX_SESSION_TITLE = "Codex Session";
const CODEX_SUBAGENT_TTL_MS = 10 * 60 * 1000;

const codexSubagentCollabStatusSchema = z.enum([
  "pendingInit",
  "running",
  "interrupted",
  "completed",
  "errored",
  "shutdown",
  "notFound",
]);

export const codexSubagentSessionSchema = z.object({
  threadId: z.string(),
  parentThreadId: z.string().optional(),
  nickname: z.string().optional(),
  role: z.string().optional(),
  preview: z.string().optional(),
  initialPrompt: z.string().optional(),
  status: sessionStatusSchema
    .transform(() => "stopped" as SessionStatus)
    .catch("stopped"),
  collabStatus: codexSubagentCollabStatusSchema.optional(),
  message: z.string().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  lastActivityAt: z.number().default(Date.now),
});
export type CodexSubagentSessionData = z.infer<
  typeof codexSubagentSessionSchema
>;

export const codexLocalTerminalSessionSchema = commonSessionSchema.extend({
  type: z.literal("codex-local-terminal"),
  codexSessionId: z.string().optional(),
  subagentsByThreadId: z
    .record(z.string(), codexSubagentSessionSchema)
    .optional()
    .catch(undefined),
  subagentOrder: z.array(z.string()).optional().catch(undefined),
  startupConfig: z.object({
    cwd: z.string(),
    model: z.string().optional(),
    modelReasoningEffort: codexModelReasoningEffortSchema.default("high"),
    fastMode: codexFastModeSchema.optional(),
    permissionMode: z.enum(["default", "full-auto", "yolo"]).default("default"),
    initialPrompt: z.string().optional(),
    configOverrides: z.string().optional(),
    mcpEnabled: z.boolean().optional().catch(undefined),
  }),
});
export type CodexLocalTerminalSessionData = z.infer<
  typeof codexLocalTerminalSessionSchema
>;

const startCodexSessionSchema = z.object({
  cwd: z.string(),
  cols: z.number().optional(),
  rows: z.number().optional(),
  sessionName: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  model: z.string().optional(),
  modelReasoningEffort: codexModelReasoningEffortSchema.default("high"),
  fastMode: codexFastModeSchema.default("default"),
  permissionMode: z.enum(["default", "full-auto", "yolo"]).default("default"),
  initialPrompt: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  configOverrides: z.string().optional(),
  mcpEnabled: z.boolean().optional(),
});

const renameCodexSessionSchema = z.object({
  sessionId: z.string(),
  title: z.string().trim().min(1),
});

const forkCodexSessionSchema = z.object({
  sessionId: z.string(),
  cols: z.number().optional(),
  rows: z.number().optional(),
});

export const codexSessionsRouter = {
  startSession: procedure
    .input(startCodexSessionSchema)
    .handler(async ({ input, context }) => {
      const sessionId = context.sessions.codex.createSession(input);

      await call(
        codexSessionsRouter.resumeSession,
        { sessionId, cols: input.cols, rows: input.rows },
        { context },
      );

      return { sessionId };
    }),
  resumeSession: procedure
    .input(
      z.object({
        sessionId: z.string(),
        cols: z.number().optional(),
        rows: z.number().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const sessionId = input.sessionId;
      const state = context.sessions.state;

      const session = state.state[sessionId];
      if (!session || session.type !== "codex-local-terminal") {
        return;
      }

      await context.skillsService.ensureFreshForPath(session.startupConfig.cwd);

      await context.sessions.codex.startLiveSession({
        sessionId,
        codexSessionId: session.codexSessionId,
        cwd: session.startupConfig.cwd,
        model: session.startupConfig.model,
        modelReasoningEffort: session.startupConfig.modelReasoningEffort,
        fastMode: session.startupConfig.fastMode,
        permissionMode: session.startupConfig
          .permissionMode as CodexPermissionMode,
        initialPrompt: session.codexSessionId
          ? undefined
          : session.startupConfig.initialPrompt,
        configOverrides: session.startupConfig.configOverrides,
        mcpEnabled: session.startupConfig.mcpEnabled,
        cols: input.cols,
        rows: input.rows,
      });

      return { sessionId };
    }),
  forkSession: procedure
    .input(forkCodexSessionSchema)
    .handler(async ({ input, context }) => {
      const source = context.sessions.state.state[input.sessionId];
      await context.skillsService.ensureFreshForPath(
        source?.type === "codex-local-terminal"
          ? source.startupConfig.cwd
          : null,
      );
      return await context.sessions.codex.forkSession(input);
    }),
  stopLiveSession: procedure
    .input(z.object({ sessionId: z.string() }))
    .handler(async ({ input, context }) => {
      return await context.sessions.codex.stopLiveSession(input.sessionId);
    }),
  deleteSession: procedure
    .input(z.object({ sessionId: z.string() }))
    .handler(async ({ input, context }) => {
      return await context.sessions.codex.deleteSession(input.sessionId);
    }),
  renameSession: procedure
    .input(renameCodexSessionSchema)
    .handler(async ({ input, context }) => {
      context.sessions.codex.renameSession(input.sessionId, input.title);
    }),
  getUsage: procedure.handler(getCodexUsage),
  subscribeToSessionTerminal: procedure
    .input(z.object({ sessionId: z.string() }))
    .handler(async function* ({ input, context, signal }) {
      const { snapshot, stream, isLive } =
        await context.terminalManager.subscribeToTerminalEvents(
          input.sessionId,
          signal,
        );

      if (isLive) {
        yield { type: "clear" } as TerminalEvent;
        if (snapshot) {
          yield { type: "data", data: snapshot } as TerminalEvent;
        }
      }
      for await (const event of stream) {
        yield event as TerminalEvent;
      }
    }),
  writeToSessionTerminal: procedure
    .input(z.object({ sessionId: z.string(), data: z.string() }))
    .handler(async ({ input, context }) => {
      context.terminalManager.writeToTerminal(input.sessionId, input.data);
    }),
  resizeSessionTerminal: procedure
    .input(
      z.object({ sessionId: z.string(), cols: z.number(), rows: z.number() }),
    )
    .handler(async ({ input, context }) => {
      context.terminalManager.resizeTerminal(
        input.sessionId,
        input.cols,
        input.rows,
      );
    }),
};

interface CodexSessionRecord {
  terminalId: string;
  appServer: CodexAppServerProcess;
  tracker: CodexAppServerTracker;
  dispose: () => Promise<void>;
}

interface CodexSessionsManagerOptions {
  state: SessionServiceState;
  terminalManager?: TerminalManager;
  titleGeneration?: TitleGenerationService;
  getMcpServerUrl?: (context: McpRequestContext) => string | null;
}

function getCodexSessionStatus(
  terminalStatus: TerminalSessionStatus,
  trackerState: CodexAppServerSessionState | null,
): SessionStatus {
  if (terminalStatus === "starting") return "starting";
  if (terminalStatus === "stopping") return "stopping";
  if (terminalStatus === "error") return "error";
  if (terminalStatus === "stopped") return "stopped";

  if (trackerState === "awaiting_approval") return "awaiting_approval";
  if (trackerState === "awaiting_user_response")
    return "awaiting_user_response";
  if (trackerState === "running") return "running";
  if (trackerState === "error") return "error";

  return "idle";
}

function normalizeSubagentStatus(
  status: CodexAppServerSubagentUpdate["status"] | undefined,
): SessionStatus | undefined {
  if (!status) {
    return undefined;
  }
  switch (status) {
    case "starting":
    case "stopped":
    case "running":
    case "awaiting_approval":
    case "awaiting_user_response":
    case "error":
      return status;
  }
}

function collabStatusToSessionStatus(
  status: CodexAppServerCollabAgentStatus | undefined,
): SessionStatus | undefined {
  switch (status) {
    case "pendingInit":
      return "starting";
    case "running":
      return "running";
    case "completed":
      return "awaiting_user_response";
    case "errored":
    case "notFound":
      return "error";
    case "interrupted":
    case "shutdown":
      return "stopped";
    case undefined:
      return undefined;
  }
}

function isActiveCodexSubagent(subagent: CodexSubagentSessionData): boolean {
  if (
    subagent.collabStatus === "pendingInit" ||
    subagent.collabStatus === "running"
  ) {
    return true;
  }

  return (
    !subagent.collabStatus &&
    (subagent.status === "starting" ||
      subagent.status === "running" ||
      subagent.status === "awaiting_approval")
  );
}

function pruneExpiredCodexSubagents(
  session: CodexLocalTerminalSessionData,
  now = Date.now(),
): boolean {
  if (!session.subagentsByThreadId) {
    return false;
  }

  let changed = false;
  for (const [threadId, subagent] of Object.entries(
    session.subagentsByThreadId,
  )) {
    if (isActiveCodexSubagent(subagent)) {
      continue;
    }
    if (now - subagent.lastActivityAt < CODEX_SUBAGENT_TTL_MS) {
      continue;
    }

    delete session.subagentsByThreadId[threadId];
    changed = true;
  }

  if (!changed) {
    return false;
  }

  const remainingThreadIds = new Set(Object.keys(session.subagentsByThreadId));
  session.subagentOrder = (session.subagentOrder ?? []).filter((threadId) =>
    remainingThreadIds.has(threadId),
  );

  if (remainingThreadIds.size === 0) {
    delete session.subagentsByThreadId;
    delete session.subagentOrder;
  }

  return true;
}

function getNextCodexSubagentPruneDelay(
  session: CodexLocalTerminalSessionData,
  now = Date.now(),
): number | null {
  if (!session.subagentsByThreadId) {
    return null;
  }

  let nextDelay: number | null = null;
  for (const subagent of Object.values(session.subagentsByThreadId)) {
    if (isActiveCodexSubagent(subagent)) {
      continue;
    }

    const delay = CODEX_SUBAGENT_TTL_MS - (now - subagent.lastActivityAt);
    if (delay <= 0) {
      return 0;
    }
    nextDelay = nextDelay === null ? delay : Math.min(nextDelay, delay);
  }

  return nextDelay;
}

function markCodexSubagentsStopped(
  session: CodexLocalTerminalSessionData,
  now = Date.now(),
): boolean {
  if (!session.subagentsByThreadId) {
    return false;
  }

  let changed = false;
  for (const subagent of Object.values(session.subagentsByThreadId)) {
    if (!isActiveCodexSubagent(subagent)) {
      continue;
    }
    subagent.status = "stopped";
    subagent.collabStatus = "shutdown";
    subagent.lastActivityAt = now;
    changed = true;
  }

  return changed;
}

function normalizeCodexTitlePrompt(prompt: string): string {
  const trimmedPrompt = prompt.trim();
  return /^\/plan(?:\s+|$)/.test(trimmedPrompt)
    ? trimmedPrompt.replace(/^\/plan(?:\s+)?/, "").trim()
    : trimmedPrompt;
}

export class CodexSessionsManager {
  readonly liveSessions = new Map<string, CodexSessionRecord>();
  private readonly sessionsState: SessionServiceState;
  private readonly terminalManager: TerminalManager;
  private readonly titleGeneration: TitleGenerationService | null;
  private readonly getMcpServerUrl:
    | ((context: McpRequestContext) => string | null)
    | null;
  private readonly subagentPruneTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(options: CodexSessionsManagerOptions | SessionServiceState) {
    if ("updateState" in options) {
      this.sessionsState = options;
      this.terminalManager = new TerminalManager();
      this.titleGeneration = null;
      this.getMcpServerUrl = null;
      for (const [sessionId, session] of Object.entries(
        this.sessionsState.state,
      )) {
        if (session.type === "codex-local-terminal") {
          this.terminalManager.registerTerminal(sessionId);
          this.pruneExpiredSubagents(sessionId);
          this.scheduleSubagentPrune(sessionId);
        }
      }
      return;
    }

    this.sessionsState = options.state;
    this.terminalManager = options.terminalManager ?? new TerminalManager();
    this.titleGeneration = options.titleGeneration ?? null;
    this.getMcpServerUrl = options.getMcpServerUrl ?? null;
    for (const [sessionId, session] of Object.entries(
      this.sessionsState.state,
    )) {
      if (session.type === "codex-local-terminal") {
        this.terminalManager.registerTerminal(sessionId);
        this.pruneExpiredSubagents(sessionId);
        this.scheduleSubagentPrune(sessionId);
      }
    }
  }

  createSession(input: z.infer<typeof startCodexSessionSchema>): string {
    const sessionId = generateUniqueSessionId();
    const sessionName = input.sessionName?.trim() || undefined;
    const initialPrompt = input.initialPrompt?.trim() || undefined;

    const newSession: CodexLocalTerminalSessionData = {
      sessionId,
      type: "codex-local-terminal",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "stopped",
      title: sessionName ?? DEFAULT_CODEX_SESSION_TITLE,
      codexSessionId: undefined,
      startupConfig: {
        cwd: input.cwd,
        model: input.model,
        modelReasoningEffort: input.modelReasoningEffort,
        fastMode: input.fastMode,
        permissionMode: input.permissionMode,
        initialPrompt,
        configOverrides: input.configOverrides,
        mcpEnabled: input.mcpEnabled,
      },
    };

    this.terminalManager.registerTerminal(sessionId);
    this.sessionsState.updateState((state) => {
      state[sessionId] = newSession;
    });

    if (!sessionName && initialPrompt) {
      this.maybeGenerateTitleFromInitialPrompt(sessionId, initialPrompt);
    }

    return sessionId;
  }

  private getSessionState(sessionId: string): CodexLocalTerminalSessionData {
    const session = this.sessionsState.state[sessionId];
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (session.type !== "codex-local-terminal") {
      throw new Error(
        `Session ${sessionId} is not a Codex local terminal session`,
      );
    }
    return session;
  }

  private pruneExpiredSubagents(sessionId: string): boolean {
    let pruned = false;
    this.sessionsState.updateState((state) => {
      const session = state[sessionId];
      if (!session || session.type !== "codex-local-terminal") {
        return;
      }

      pruned = pruneExpiredCodexSubagents(session);
    });

    return pruned;
  }

  private scheduleSubagentPrune(sessionId: string): void {
    const existingTimer = this.subagentPruneTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.subagentPruneTimers.delete(sessionId);
    }

    const session = this.sessionsState.state[sessionId];
    if (!session || session.type !== "codex-local-terminal") {
      return;
    }

    const delay = getNextCodexSubagentPruneDelay(session);
    if (delay === null) {
      return;
    }

    const timer = setTimeout(() => {
      this.subagentPruneTimers.delete(sessionId);
      this.pruneExpiredSubagents(sessionId);
      this.scheduleSubagentPrune(sessionId);
    }, delay);

    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }

    this.subagentPruneTimers.set(sessionId, timer);
  }

  private clearSubagentPruneTimer(sessionId: string): void {
    const timer = this.subagentPruneTimers.get(sessionId);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.subagentPruneTimers.delete(sessionId);
  }

  private markSubagentsStopped(sessionId: string): void {
    let changed = false;
    this.sessionsState.updateState((state) => {
      const session = state[sessionId];
      if (!session || session.type !== "codex-local-terminal") {
        return;
      }

      changed = markCodexSubagentsStopped(session);
    });

    if (changed) {
      this.scheduleSubagentPrune(sessionId);
    }
  }

  private maybeGenerateTitleFromInitialPrompt(
    sessionId: string,
    initialPrompt: string,
  ) {
    if (!this.titleGeneration) {
      return;
    }

    const prompt = normalizeCodexTitlePrompt(initialPrompt);
    if (!prompt) {
      return;
    }

    const state = this.sessionsState;
    this.titleGeneration.requestFromPrompt({
      sessionId,
      prompt,
      defaultTitle: DEFAULT_CODEX_SESSION_TITLE,
      getTitle: () => {
        const session = state.state[sessionId];
        return session?.type === "codex-local-terminal"
          ? session.title
          : undefined;
      },
      setTitle: (title) => {
        state.updateState((draft) => {
          const session = draft[sessionId];
          if (!session || session.type !== "codex-local-terminal") {
            return;
          }
          session.title = title;
        });
      },
    });
  }

  private async maybeGenerateTitleFromCodexThread(
    sessionId: string,
    tracker: CodexAppServerTracker,
  ) {
    if (!this.titleGeneration) {
      return;
    }

    const session = this.sessionsState.state[sessionId];
    if (
      !session ||
      session.type !== "codex-local-terminal" ||
      session.title !== DEFAULT_CODEX_SESSION_TITLE
    ) {
      return;
    }

    const prompt = await tracker.readThreadPrompt().catch(() => undefined);
    if (prompt) {
      this.maybeGenerateTitleFromInitialPrompt(sessionId, prompt);
    }
  }

  private persistOfflineBuffer(sessionId: string, offlineBuffer?: string) {
    if (!offlineBuffer) {
      return;
    }

    this.sessionsState.updateState((state) => {
      const session = state[sessionId];
      if (!session || session.type !== "codex-local-terminal") {
        return;
      }
      session.offlineBuffer = offlineBuffer;
    });
  }

  async startLiveSession({
    sessionId,
    codexSessionId,
    forkSessionId,
    cwd,
    model,
    modelReasoningEffort,
    fastMode,
    permissionMode,
    initialPrompt,
    configOverrides,
    mcpEnabled,
    cols,
    rows,
  }: {
    sessionId: string;
    codexSessionId?: string;
    forkSessionId?: string;
    cwd: string;
    model?: string;
    modelReasoningEffort: CodexModelReasoningEffort;
    fastMode?: CodexFastMode;
    permissionMode: CodexPermissionMode;
    initialPrompt?: string;
    configOverrides?: string;
    mcpEnabled?: boolean;
    cols?: number;
    rows?: number;
  }): Promise<void> {
    const liveSession = this.liveSessions.get(sessionId);
    const state = this.sessionsState;
    if (liveSession) {
      return;
    }

    const setSessionStatus = (nextStatus: SessionStatus) => {
      state.updateState((state) => {
        const target = state[sessionId];
        if (!target) {
          return;
        }
        target.status = nextStatus;
      });
    };
    const setSessionErrorMessage = (errorMessage?: string) => {
      state.updateState((state) => {
        const target = state[sessionId];
        if (!target) {
          return;
        }
        target.errorMessage = errorMessage;
      });
    };
    setSessionStatus("starting");
    setSessionErrorMessage(undefined);

    // Determine if we need plan mode (deferred prompt)
    const isPlanMode = initialPrompt?.startsWith("/plan ");
    let shouldSwitchToPlanMode = isPlanMode;
    const deferredPrompt =
      (isPlanMode
        ? initialPrompt?.substring("/plan ".length).trim()
        : undefined) || undefined;

    let trackerState: CodexAppServerSessionState | null = null;
    let runtimeErrorMessage: string | undefined;

    const syncSessionStatus = () => {
      const runtime = this.terminalManager.getRuntime(sessionId);
      const terminalStatus = runtime?.status ?? "stopped";
      setSessionStatus(getCodexSessionStatus(terminalStatus, trackerState));
    };
    const updateSubagent = (update: CodexAppServerSubagentUpdate) => {
      state.updateState((state) => {
        const session = state[sessionId];
        if (!session || session.type !== "codex-local-terminal") {
          return;
        }

        session.subagentsByThreadId ??= {};
        session.subagentOrder ??= [];

        const existing = session.subagentsByThreadId[update.threadId];
        const now = Date.now();
        const nextStatus =
          normalizeSubagentStatus(update.status) ??
          collabStatusToSessionStatus(update.collabStatus) ??
          existing?.status ??
          "starting";

        session.subagentsByThreadId[update.threadId] = {
          threadId: update.threadId,
          parentThreadId: update.parentThreadId ?? existing?.parentThreadId,
          nickname: update.nickname ?? existing?.nickname,
          role: update.role ?? existing?.role,
          preview: update.preview ?? existing?.preview,
          initialPrompt: update.initialPrompt ?? existing?.initialPrompt,
          status: nextStatus,
          collabStatus: update.collabStatus ?? existing?.collabStatus,
          message: update.message ?? existing?.message,
          createdAt: update.createdAt ?? existing?.createdAt,
          updatedAt: update.updatedAt ?? existing?.updatedAt,
          lastActivityAt: now,
        };

        if (!session.subagentOrder.includes(update.threadId)) {
          session.subagentOrder.push(update.threadId);
        }
        session.lastActivityAt = now;
      });
      this.pruneExpiredSubagents(sessionId);
      this.scheduleSubagentPrune(sessionId);
    };

    const appServer = new CodexAppServerProcess({
      sessionId,
      onUnexpectedExit: ({ exitCode, signal }) => {
        runtimeErrorMessage = `Codex app-server exited unexpectedly (${signal ?? exitCode ?? "unknown"}).`;
        setSessionErrorMessage(runtimeErrorMessage);
        trackerState = "error";
        syncSessionStatus();
      },
    });
    let tracker: CodexAppServerTracker | null = null;
    const mcpServerUrl =
      mcpEnabled === false ? null : (this.getMcpServerUrl?.({ cwd }) ?? null);

    try {
      await appServer.start({ cwd, mcpServerUrl });

      tracker = new CodexAppServerTracker({
        sessionId,
        wsUrl: appServer.wsUrl,
        initialThreadId: codexSessionId,
        onThreadId: (threadId) => {
          state.updateState((state) => {
            const session = state[sessionId];
            if (!session || session.type !== "codex-local-terminal") {
              return;
            }
            session.codexSessionId = threadId;
          });
        },
        onStatusChange: (nextTrackerState) => {
          trackerState = nextTrackerState;
          syncSessionStatus();
          if (nextTrackerState === "awaiting_user_response" && tracker) {
            void this.maybeGenerateTitleFromCodexThread(sessionId, tracker);
          }
        },
        onSubagentUpdate: updateSubagent,
        onError: (errorMessage) => {
          runtimeErrorMessage = errorMessage;
          setSessionErrorMessage(errorMessage);
        },
      });
      await tracker.start();
    } catch (error) {
      await tracker?.stop().catch(() => undefined);
      await appServer.stop().catch(() => undefined);

      const errorMessage =
        error instanceof Error
          ? error.message
          : "Failed to start Codex app-server session.";
      setSessionErrorMessage(errorMessage);
      setSessionStatus("error");
      throw error;
    }

    const { args } = buildCodexArgs({
      remoteWsUrl: appServer.wsUrl,
      resumeSessionId: codexSessionId,
      forkSessionId,
      permissionMode,
      model,
      modelReasoningEffort,
      fastMode,
      configOverrides,
      mcpServerUrl,
      initialPrompt: isPlanMode ? undefined : initialPrompt,
    });

    this.terminalManager.startTerminal({
      terminalId: sessionId,
      launch: {
        file: "codex",
        args,
        runWithShell: true,
        cwd,
        cols,
        rows,
      },
      onStatusChange: (status) => {
        syncSessionStatus();

        if (status === "running" && shouldSwitchToPlanMode) {
          shouldSwitchToPlanMode = false;

          if (deferredPrompt) {
            setTimeout(() => {
              this.terminalManager.writeToTerminal(sessionId, "\x1b[Z");
              this.terminalManager.writeToTerminal(
                sessionId,
                `${deferredPrompt}`,
              );
              setTimeout(() => {
                this.terminalManager.writeToTerminal(sessionId, "\x1b[13u");
              }, 100);
            }, 100);
          }
        }
      },
      onExit: (payload) => {
        void this.stopLiveSession(sessionId, payload.snapshot);
        state.updateState((state) => {
          const session = state[sessionId];
          if (!session) {
            return;
          }

          const errorMessage = payload.errorMessage ?? runtimeErrorMessage;
          session.status = errorMessage ? "error" : "stopped";
          session.errorMessage = errorMessage;
          session.offlineBuffer = payload.snapshot;
        });
      },
    });

    const session: CodexSessionRecord = {
      terminalId: sessionId,
      appServer,
      tracker,
      dispose: async () => {
        await this.terminalManager.stopTerminal(sessionId);
        await tracker.stop();
        await appServer.stop();
      },
    };
    this.liveSessions.set(sessionId, session);

    if (!this.terminalManager.getRuntime(sessionId)) {
      await session.dispose();
      this.liveSessions.delete(sessionId);
      return;
    }

    syncSessionStatus();
  }

  async forkSession(input: z.infer<typeof forkCodexSessionSchema>) {
    const sourceSession = this.getSessionState(input.sessionId);
    const sourceCodexSessionId = sourceSession.codexSessionId?.trim();
    if (!sourceCodexSessionId) {
      throw new Error("Codex session is not ready to fork yet.");
    }

    const sessionId = generateUniqueSessionId();
    const forkedSession: CodexLocalTerminalSessionData = {
      sessionId,
      type: "codex-local-terminal",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "stopped",
      title: `${sourceSession.title} (fork)`,
      codexSessionId: undefined,
      startupConfig: {
        cwd: sourceSession.startupConfig.cwd,
        model: sourceSession.startupConfig.model,
        modelReasoningEffort: sourceSession.startupConfig.modelReasoningEffort,
        fastMode: sourceSession.startupConfig.fastMode,
        permissionMode: sourceSession.startupConfig.permissionMode,
        initialPrompt: sourceSession.startupConfig.initialPrompt,
        configOverrides: sourceSession.startupConfig.configOverrides,
        mcpEnabled: sourceSession.startupConfig.mcpEnabled,
      },
    };

    this.terminalManager.registerTerminal(sessionId);
    this.sessionsState.updateState((state) => {
      state[sessionId] = forkedSession;
    });

    await this.startLiveSession({
      sessionId,
      forkSessionId: sourceCodexSessionId,
      cwd: forkedSession.startupConfig.cwd,
      model: forkedSession.startupConfig.model,
      modelReasoningEffort: forkedSession.startupConfig.modelReasoningEffort,
      fastMode: forkedSession.startupConfig.fastMode,
      permissionMode: forkedSession.startupConfig.permissionMode,
      configOverrides: forkedSession.startupConfig.configOverrides,
      mcpEnabled: forkedSession.startupConfig.mcpEnabled,
      cols: input.cols,
      rows: input.rows,
    });

    return { sessionId };
  }

  async stopLiveSession(sessionId: string, offlineBuffer?: string) {
    const liveSession = this.liveSessions.get(sessionId);
    if (!liveSession) {
      return;
    }

    this.markSubagentsStopped(sessionId);
    this.persistOfflineBuffer(
      sessionId,
      offlineBuffer || (await this.terminalManager.getSnapshot(sessionId)),
    );
    this.liveSessions.delete(sessionId);
    await liveSession.dispose();
  }

  async dispose(): Promise<void> {
    const sessionIds = [...this.liveSessions.keys()];
    await Promise.allSettled(
      sessionIds.map(async (sessionId) => {
        await this.stopLiveSession(sessionId);
      }),
    );
    for (const sessionId of this.subagentPruneTimers.keys()) {
      this.clearSubagentPruneTimer(sessionId);
    }
  }

  async deleteSession(sessionId: string) {
    await this.stopLiveSession(sessionId);
    this.clearSubagentPruneTimer(sessionId);
    await this.terminalManager.unregisterTerminal(sessionId);
    this.sessionsState.updateState((state) => {
      delete state[sessionId];
    });
    this.titleGeneration?.forget(sessionId);
  }

  renameSession(sessionId: string, title: string) {
    const nextTitle = title.trim();
    if (!nextTitle) {
      return;
    }

    this.sessionsState.updateState((state) => {
      const session = state[sessionId];
      if (!session || session.type !== "codex-local-terminal") {
        return;
      }
      session.title = nextTitle;
    });

    this.titleGeneration?.forget(sessionId);
  }

  subscribeToTerminalEvents(sessionId: string, signal?: AbortSignal) {
    return this.terminalManager.subscribeToTerminalEvents(sessionId, signal);
  }
}
