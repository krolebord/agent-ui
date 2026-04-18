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
  type CodexAppServerSessionState,
  CodexAppServerTracker,
} from "../codex-app-server-tracker";
import { buildCodexArgs } from "../codex-cli";
import { getCodexUsage } from "../codex-usage";
import { procedure } from "../orpc";
import { SessionTitleManager } from "../session-title-manager";
import { TerminalManager } from "../terminal-manager";
import type { TerminalSessionStatus } from "../terminal-session";
import {
  commonSessionSchema,
  generateUniqueSessionId,
  type SessionStatus,
} from "./common";
import type { SessionServiceState } from "./state";

const DEFAULT_CODEX_SESSION_TITLE = "Codex Session";

export const codexLocalTerminalSessionSchema = commonSessionSchema.extend({
  type: z.literal("codex-local-terminal"),
  codexSessionId: z.string().optional(),
  startupConfig: z.object({
    cwd: z.string(),
    model: z.string().optional(),
    modelReasoningEffort: codexModelReasoningEffortSchema.default("high"),
    fastMode: codexFastModeSchema.optional(),
    permissionMode: z.enum(["default", "full-auto", "yolo"]).default("default"),
    initialPrompt: z.string().optional(),
    configOverrides: z.string().optional(),
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
        cols: input.cols,
        rows: input.rows,
      });

      return { sessionId };
    }),
  forkSession: procedure
    .input(forkCodexSessionSchema)
    .handler(async ({ input, context }) => {
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
        context.terminalManager.subscribeToTerminalEvents(
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
  titleManager?: SessionTitleManager;
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
  private readonly titleManager: SessionTitleManager;

  constructor(options: CodexSessionsManagerOptions | SessionServiceState) {
    if ("updateState" in options) {
      this.sessionsState = options;
      this.terminalManager = new TerminalManager();
      this.titleManager = new SessionTitleManager();
      for (const [sessionId, session] of Object.entries(
        this.sessionsState.state,
      )) {
        if (session.type === "codex-local-terminal") {
          this.terminalManager.registerTerminal(sessionId);
        }
      }
      return;
    }

    this.sessionsState = options.state;
    this.terminalManager = options.terminalManager ?? new TerminalManager();
    this.titleManager = options.titleManager ?? new SessionTitleManager();
    for (const [sessionId, session] of Object.entries(
      this.sessionsState.state,
    )) {
      if (session.type === "codex-local-terminal") {
        this.terminalManager.registerTerminal(sessionId);
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

  private maybeGenerateTitleFromInitialPrompt(
    sessionId: string,
    initialPrompt: string,
  ) {
    const prompt = normalizeCodexTitlePrompt(initialPrompt);
    if (!prompt) {
      return;
    }

    this.triggerTitleGeneration(sessionId, prompt);
  }

  private triggerTitleGeneration(sessionId: string, prompt: string) {
    const state = this.sessionsState;
    this.titleManager.maybeGenerate({
      sessionId,
      prompt,
      sessionExists: () => {
        const session = state.state[sessionId];
        return !!session && session.type === "codex-local-terminal";
      },
      onTitleReady: (title) => {
        state.updateState((state) => {
          const session = state[sessionId];
          if (!session || session.type !== "codex-local-terminal") {
            return;
          }
          if (session.title !== DEFAULT_CODEX_SESSION_TITLE) {
            return;
          }
          session.title = title;
        });
      },
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

    const applySuggestedTitle = (title: string) => {
      const nextTitle = title.trim();
      if (!nextTitle) {
        return;
      }

      state.updateState((state) => {
        const session = state[sessionId];
        if (!session || session.type !== "codex-local-terminal") {
          return;
        }
        if (session.title !== DEFAULT_CODEX_SESSION_TITLE) {
          return;
        }
        session.title = nextTitle;
      });
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

    try {
      await appServer.start();

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
        },
        onTitleUpdated: (title) => {
          applySuggestedTitle(title);
        },
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
        void this.stopLiveSession(sessionId);
        state.updateState((state) => {
          const session = state[sessionId];
          if (!session) {
            return;
          }

          const errorMessage = payload.errorMessage ?? runtimeErrorMessage;
          session.status = errorMessage ? "error" : "stopped";
          session.errorMessage = errorMessage;
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
      cols: input.cols,
      rows: input.rows,
    });

    return { sessionId };
  }

  async stopLiveSession(sessionId: string) {
    const liveSession = this.liveSessions.get(sessionId);
    if (!liveSession) {
      return;
    }

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
  }

  async deleteSession(sessionId: string) {
    await this.stopLiveSession(sessionId);
    await this.terminalManager.unregisterTerminal(sessionId);
    this.sessionsState.updateState((state) => {
      delete state[sessionId];
    });
    this.titleManager.forget(sessionId);
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

    this.titleManager.forget(sessionId);
  }

  subscribeToTerminalEvents(sessionId: string, signal?: AbortSignal) {
    return this.terminalManager.subscribeToTerminalEvents(sessionId, signal);
  }
}
