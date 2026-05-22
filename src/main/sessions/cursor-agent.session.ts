import { call } from "@orpc/server";
import type { TerminalEvent } from "@shared/terminal-types";
import { createDisposable } from "@shared/utils";
import { z } from "zod";
import type { ClaudeActivityState } from "../../shared/claude-types";
import { CursorActivityMonitor } from "../cursor-activity-monitor";
import {
  buildCursorAgentArgs,
  type CursorAgentMode,
  type CursorAgentPermissionMode,
} from "../cursor-cli";
import { getCursorUsage } from "../cursor-usage";
import log from "../logger";
import { procedure } from "../orpc";
import { TerminalManager } from "../terminal-manager";
import type { TerminalSessionStatus } from "../terminal-session";
import type { TitleGenerationService } from "../title-generation-service";
import {
  commonSessionSchema,
  generateUniqueSessionId,
  type SessionStatus,
} from "./common";
import type { SessionServiceState } from "./state";

const DEFAULT_CURSOR_AGENT_SESSION_TITLE = "Cursor Agent Session";

const cursorAgentModeSchema = z.enum(["plan", "ask"]).optional();
const cursorAgentPermissionModeSchema = z
  .enum(["default", "yolo"])
  .default("default");

export const cursorAgentSessionSchema = commonSessionSchema.extend({
  type: z.literal("cursor-agent"),
  startupConfig: z.object({
    cwd: z.string(),
    model: z.string().optional(),
    mode: cursorAgentModeSchema,
    permissionMode: cursorAgentPermissionModeSchema,
    initialPrompt: z
      .string()
      .optional()
      .transform((v) => v?.trim()),
  }),
  cursorChatId: z.string().optional().catch(undefined),
  initialPromptSent: z.boolean().optional().catch(false),
});
export type CursorAgentSessionData = z.infer<typeof cursorAgentSessionSchema>;

const startCursorAgentSessionSchema = z.object({
  cwd: z.string(),
  cols: z.number().optional(),
  rows: z.number().optional(),
  sessionName: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  model: z.string().optional(),
  mode: cursorAgentModeSchema,
  permissionMode: cursorAgentPermissionModeSchema,
  initialPrompt: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
});

const renameCursorAgentSessionSchema = z.object({
  sessionId: z.string(),
  title: z.string().trim().min(1),
});

export const cursorAgentSessionsRouter = {
  getUsage: procedure.handler(getCursorUsage),
  startSession: procedure
    .input(startCursorAgentSessionSchema)
    .handler(async ({ input, context }) => {
      const sessionId = await context.sessions.cursorAgent.createSession(input);

      await call(
        cursorAgentSessionsRouter.resumeSession,
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
      if (!session || session.type !== "cursor-agent") {
        return;
      }

      const pendingPrompt = session.initialPromptSent
        ? undefined
        : session.startupConfig.initialPrompt;

      let plan = false;
      let initialPrompt = pendingPrompt;
      if (initialPrompt?.startsWith("/plan")) {
        plan = true;
        initialPrompt = initialPrompt.slice("/plan".length).trim() || undefined;
      }

      context.sessions.cursorAgent.startLiveSession({
        sessionId,
        cwd: session.startupConfig.cwd,
        model: session.startupConfig.model,
        mode: session.startupConfig.mode as CursorAgentMode | undefined,
        permissionMode: session.startupConfig
          .permissionMode as CursorAgentPermissionMode,
        initialPrompt,
        plan,
        cursorChatId: session.cursorChatId,
        cols: input.cols,
        rows: input.rows,
      });

      return { sessionId };
    }),
  stopLiveSession: procedure
    .input(z.object({ sessionId: z.string() }))
    .handler(async ({ input, context }) => {
      return await context.sessions.cursorAgent.stopLiveSession(
        input.sessionId,
      );
    }),
  deleteSession: procedure
    .input(z.object({ sessionId: z.string() }))
    .handler(async ({ input, context }) => {
      return await context.sessions.cursorAgent.deleteSession(input.sessionId);
    }),
  renameSession: procedure
    .input(renameCursorAgentSessionSchema)
    .handler(async ({ input, context }) => {
      context.sessions.cursorAgent.renameSession(input.sessionId, input.title);
    }),
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

interface CursorAgentSessionRecord {
  terminalId: string;
  activityMonitor: CursorActivityMonitor | null;
  dispose: () => Promise<void>;
}

interface CursorAgentSessionsManagerOptions {
  state: SessionServiceState;
  terminalManager?: TerminalManager;
  titleGeneration?: TitleGenerationService;
  cursorConfigDir?: string | null;
  sessionLogFileManager?: CursorSessionLogFileStore | null;
  cursorHooksWarning?: string | null;
}

interface CursorSessionLogFileStore {
  create(sessionId: string): string;
  cleanup(logFilePath: string | null): void;
}

function getCursorSessionStatus(
  terminalStatus: TerminalSessionStatus,
  activityState: ClaudeActivityState | null,
): SessionStatus {
  if (terminalStatus === "starting") return "starting";
  if (terminalStatus === "stopping") return "stopping";
  if (terminalStatus === "error") return "error";
  if (terminalStatus === "stopped") return "stopped";

  if (activityState === "awaiting_approval") return "awaiting_approval";
  if (activityState === "awaiting_user_response")
    return "awaiting_user_response";
  if (activityState === "working") return "running";

  return "idle";
}

export class CursorAgentSessionsManager {
  readonly liveSessions = new Map<string, CursorAgentSessionRecord>();
  private readonly sessionsState: SessionServiceState;
  private readonly terminalManager: TerminalManager;
  private readonly titleGeneration: TitleGenerationService | null;
  private readonly cursorConfigDir: string | null;
  private readonly sessionLogFileManager: CursorSessionLogFileStore | null;
  private readonly cursorHooksWarning: string | null;

  constructor(
    options: CursorAgentSessionsManagerOptions | SessionServiceState,
  ) {
    if ("updateState" in options) {
      this.sessionsState = options;
      this.terminalManager = new TerminalManager();
      this.titleGeneration = null;
      this.cursorConfigDir = null;
      this.sessionLogFileManager = null;
      this.cursorHooksWarning = null;
      for (const [sessionId, session] of Object.entries(
        this.sessionsState.state,
      )) {
        if (session.type === "cursor-agent") {
          this.terminalManager.registerTerminal(sessionId);
        }
      }
      return;
    }

    this.sessionsState = options.state;
    this.terminalManager = options.terminalManager ?? new TerminalManager();
    this.titleGeneration = options.titleGeneration ?? null;
    this.cursorConfigDir = options.cursorConfigDir ?? null;
    this.sessionLogFileManager = options.sessionLogFileManager ?? null;
    this.cursorHooksWarning = options.cursorHooksWarning ?? null;
    for (const [sessionId, session] of Object.entries(
      this.sessionsState.state,
    )) {
      if (session.type === "cursor-agent") {
        this.terminalManager.registerTerminal(sessionId);
      }
    }
  }

  private buildSessionWarning(): string | undefined {
    if (this.cursorHooksWarning) {
      return this.cursorHooksWarning;
    }

    if (!this.cursorConfigDir || !this.sessionLogFileManager) {
      return "Cursor hook monitoring is disabled; live status may be less accurate.";
    }

    return undefined;
  }

  async createSession(
    input: z.infer<typeof startCursorAgentSessionSchema>,
  ): Promise<string> {
    const sessionId = generateUniqueSessionId();
    const sessionName = input.sessionName?.trim() || undefined;
    const initialPrompt = input.initialPrompt?.trim() || undefined;

    const newSession: CursorAgentSessionData = {
      sessionId,
      type: "cursor-agent",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "stopped",
      title: sessionName ?? DEFAULT_CURSOR_AGENT_SESSION_TITLE,
      warningMessage: this.buildSessionWarning(),
      startupConfig: {
        cwd: input.cwd,
        model: input.model,
        mode: input.mode,
        permissionMode: input.permissionMode,
        initialPrompt,
      },
      cursorChatId: undefined,
    };

    this.terminalManager.registerTerminal(sessionId);
    this.sessionsState.updateState((state) => {
      state[sessionId] = newSession;
    });

    if (!sessionName && initialPrompt) {
      this.requestTitleFromUserPrompt(sessionId, initialPrompt);
    }

    return sessionId;
  }

  private requestTitleFromUserPrompt(sessionId: string, userPrompt: string) {
    if (!this.titleGeneration) {
      return;
    }

    const prompt = userPrompt.trim();
    if (!prompt) {
      return;
    }

    const state = this.sessionsState;
    this.titleGeneration.requestFromPrompt({
      sessionId,
      prompt,
      defaultTitle: DEFAULT_CURSOR_AGENT_SESSION_TITLE,
      getTitle: () => {
        const session = state.state[sessionId];
        return session?.type === "cursor-agent" ? session.title : undefined;
      },
      setTitle: (title) => {
        state.updateState((draft) => {
          const session = draft[sessionId];
          if (!session || session.type !== "cursor-agent") {
            return;
          }
          session.title = title;
        });
      },
    });
  }

  private persistOfflineBuffer(sessionId: string, offlineBuffer?: string) {
    if (!offlineBuffer) {
      return;
    }

    this.sessionsState.updateState((state) => {
      const session = state[sessionId];
      if (!session || session.type !== "cursor-agent") {
        return;
      }
      session.offlineBuffer = offlineBuffer;
    });
  }

  async startLiveSession({
    sessionId,
    cwd,
    model,
    mode,
    permissionMode,
    initialPrompt,
    plan,
    cursorChatId,
    cols,
    rows,
  }: {
    sessionId: string;
    cwd: string;
    model?: string;
    mode?: CursorAgentMode;
    permissionMode: CursorAgentPermissionMode;
    initialPrompt?: string;
    plan?: boolean;
    cursorChatId?: string;
    cols?: number;
    rows?: number;
  }) {
    const liveSession = this.liveSessions.get(sessionId);
    const state = this.sessionsState;
    if (liveSession) {
      return;
    }

    const disposable = createDisposable({
      onError: (error) => {
        log.error("Error starting cursor agent live session", error);
      },
    });

    const setSessionStatus = (nextStatus: SessionStatus) => {
      state.updateState((state) => {
        const target = state[sessionId];
        if (!target) {
          return;
        }
        target.status = nextStatus;
        target.lastActivityAt = Date.now();
      });
    };

    const hookLogFilePath =
      this.cursorConfigDir && this.sessionLogFileManager
        ? this.sessionLogFileManager.create(sessionId)
        : null;
    if (hookLogFilePath) {
      disposable.addDisposable(() =>
        this.sessionLogFileManager?.cleanup(hookLogFilePath),
      );
    }

    const activityMonitor = hookLogFilePath
      ? new CursorActivityMonitor({
          onStatusChange: (nextActivityStatus) => {
            activityState = nextActivityStatus;
            const runtime = this.terminalManager.getRuntime(sessionId);
            if (!runtime) {
              return;
            }
            setSessionStatus(
              getCursorSessionStatus(runtime.status, activityState),
            );
          },
          onHookEvent: (event) => {
            if (event.hook_event_name === "beforeSubmitPrompt") {
              const session = state.state[sessionId];
              if (
                session?.type === "cursor-agent" &&
                session.title === DEFAULT_CURSOR_AGENT_SESSION_TITLE
              ) {
                const prompt = event.prompt?.trim();
                if (prompt) {
                  this.requestTitleFromUserPrompt(sessionId, prompt);
                }
              }
            }

            const hydratedCursorChatId =
              event.conversation_id ?? event.session_id;
            if (!hydratedCursorChatId) {
              return;
            }

            state.updateState((state) => {
              const session = state[sessionId];
              if (!session || session.type !== "cursor-agent") {
                return;
              }
              if (session.cursorChatId) {
                return;
              }
              session.cursorChatId = hydratedCursorChatId;
            });
          },
        })
      : null;

    let activityState: ClaudeActivityState | null = activityMonitor
      ? activityMonitor.getState()
      : null;

    const { args: finalArgs } = buildCursorAgentArgs({
      cursorChatId,
      cwd,
      model,
      mode,
      permissionMode,
      initialPrompt,
      plan,
    });

    const terminal = this.terminalManager.startTerminal({
      terminalId: sessionId,
      launch: {
        file: "cursor",
        args: finalArgs,
        runWithShell: true,
        cwd,
        cols,
        rows,
        env: this.cursorConfigDir
          ? {
              CURSOR_CONFIG_DIR: this.cursorConfigDir,
              ...(hookLogFilePath
                ? {
                    AGENT_UI_CURSOR_STATE_FILE: hookLogFilePath,
                  }
                : {}),
            }
          : undefined,
      },
      onStatusChange: (status) => {
        setSessionStatus(getCursorSessionStatus(status, activityState));
      },
      onExit: (payload) => {
        void this.stopLiveSession(sessionId, payload.snapshot);
        state.updateState((state) => {
          state[sessionId].status = payload.errorMessage ? "error" : "stopped";
          state[sessionId].errorMessage = payload.errorMessage;
          state[sessionId].offlineBuffer = payload.snapshot;
        });
      },
    });
    disposable.addDisposable(() => terminal.stop());
    if (activityMonitor) {
      disposable.addDisposable(() => activityMonitor.stopMonitoring());
    }

    if (activityMonitor && hookLogFilePath) {
      await activityMonitor.startMonitoring({
        stateFilePath: hookLogFilePath,
      });
    }

    // Mark initial prompt as sent so subsequent resumes don't re-send it
    if (initialPrompt) {
      state.updateState((state) => {
        const session = state[sessionId];
        if (session?.type === "cursor-agent") {
          session.initialPromptSent = true;
        }
      });
    }

    const session: CursorAgentSessionRecord = {
      terminalId: sessionId,
      activityMonitor,
      dispose: disposable.dispose,
    };
    this.liveSessions.set(sessionId, session);
    disposable.addDisposable(() => this.liveSessions.delete(sessionId));

    if (!this.terminalManager.getRuntime(sessionId)) {
      await disposable.dispose();
    }
  }

  async stopLiveSession(sessionId: string, offlineBuffer?: string) {
    const liveSession = this.liveSessions.get(sessionId);
    if (!liveSession) {
      return;
    }
    this.persistOfflineBuffer(
      sessionId,
      offlineBuffer || (await this.terminalManager.getSnapshot(sessionId)),
    );
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
    this.titleGeneration?.forget(sessionId);
  }

  renameSession(sessionId: string, title: string) {
    const nextTitle = title.trim();
    if (!nextTitle) {
      return;
    }

    this.sessionsState.updateState((state) => {
      const session = state[sessionId];
      if (!session || session.type !== "cursor-agent") {
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
