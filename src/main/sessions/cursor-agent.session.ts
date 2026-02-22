import { execFile } from "node:child_process";
import { call, EventPublisher } from "@orpc/server";
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
import { withDebouncedRunner } from "../debounce-runner";
import { generateCursorSessionTitle } from "../generate-cursor-session-title";
import log from "../logger";
import { procedure } from "../orpc";
import { SessionTitleManager } from "../session-title-manager";
import {
  createTerminalSession,
  type TerminalSession,
} from "../terminal-session";
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
      const { bufferedOutput, stream, isLive } =
        context.sessions.cursorAgent.subscribeToTerminalEvents(
          input.sessionId,
          signal,
        );

      if (isLive) {
        yield { type: "clear" } as TerminalEvent;
        if (bufferedOutput) {
          yield { type: "data", data: bufferedOutput } as TerminalEvent;
        }
      }
      for await (const event of stream) {
        yield event as TerminalEvent;
      }
    }),
  writeToSessionTerminal: procedure
    .input(z.object({ sessionId: z.string(), data: z.string() }))
    .handler(async ({ input, context }) => {
      const session = context.sessions.cursorAgent.liveSessions.get(
        input.sessionId,
      );
      if (!session) {
        return;
      }
      session.terminal.write(input.data);
    }),
  resizeSessionTerminal: procedure
    .input(
      z.object({ sessionId: z.string(), cols: z.number(), rows: z.number() }),
    )
    .handler(async ({ input, context }) => {
      const session = context.sessions.cursorAgent.liveSessions.get(
        input.sessionId,
      );
      if (!session) {
        return;
      }
      session.terminal.resize(input.cols, input.rows);
    }),
};

interface CursorAgentSessionRecord {
  terminal: TerminalSession;
  activityMonitor: CursorActivityMonitor | null;
  dispose: () => Promise<void>;
}

interface CursorAgentSessionsManagerOptions {
  state: SessionServiceState;
  titleManager?: SessionTitleManager;
  cursorConfigDir?: string | null;
  cursorHookEventsFilePath?: string | null;
  cursorHooksWarning?: string | null;
}

/**
 * Runs `cursor agent create-chat` and returns the chatId from stdout.
 */
function createCursorChat(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("cursor", ["agent", "create-chat"], (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            `cursor agent create-chat failed: ${stderr || error.message}`,
          ),
        );
        return;
      }
      const chatId = stdout.trim();
      if (!chatId) {
        reject(new Error("cursor agent create-chat returned empty output"));
        return;
      }
      resolve(chatId);
    });
  });
}

function getCursorSessionStatus(
  terminal: TerminalSession,
  activityState: ClaudeActivityState | null,
): SessionStatus {
  const terminalStatus = terminal.status;

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
  private readonly eventPublisher = new EventPublisher<
    Record<string, TerminalEvent>
  >({
    maxBufferedEvents: 0,
  });
  private readonly sessionsState: SessionServiceState;
  private readonly titleManager: SessionTitleManager;
  private readonly cursorConfigDir: string | null;
  private readonly cursorHookEventsFilePath: string | null;
  private readonly cursorHooksWarning: string | null;

  constructor(
    options: CursorAgentSessionsManagerOptions | SessionServiceState,
  ) {
    if ("updateState" in options) {
      this.sessionsState = options;
      this.titleManager = new SessionTitleManager({
        generateTitle: generateCursorSessionTitle,
      });
      this.cursorConfigDir = null;
      this.cursorHookEventsFilePath = null;
      this.cursorHooksWarning = null;
      return;
    }

    this.sessionsState = options.state;
    this.titleManager =
      options.titleManager ??
      new SessionTitleManager({ generateTitle: generateCursorSessionTitle });
    this.cursorConfigDir = options.cursorConfigDir ?? null;
    this.cursorHookEventsFilePath = options.cursorHookEventsFilePath ?? null;
    this.cursorHooksWarning = options.cursorHooksWarning ?? null;
  }

  private buildSessionWarning(
    cursorChatId: string | undefined,
  ): string | undefined {
    if (this.cursorHooksWarning) {
      return this.cursorHooksWarning;
    }

    if (!this.cursorConfigDir || !this.cursorHookEventsFilePath) {
      return "Cursor hook monitoring is disabled; live status may be less accurate.";
    }

    if (!cursorChatId) {
      return "Cursor chat ID unavailable; hook-driven status tracking is disabled for this session.";
    }

    return undefined;
  }

  async createSession(
    input: z.infer<typeof startCursorAgentSessionSchema>,
  ): Promise<string> {
    const sessionId = generateUniqueSessionId();
    const sessionName = input.sessionName?.trim() || undefined;
    const initialPrompt = input.initialPrompt?.trim() || undefined;

    let cursorChatId: string | undefined;
    try {
      cursorChatId = await createCursorChat();
    } catch (error) {
      log.error(
        "Failed to create cursor chat, proceeding without chatId",
        error,
      );
    }

    const newSession: CursorAgentSessionData = {
      sessionId,
      type: "cursor-agent",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "stopped",
      title: sessionName ?? DEFAULT_CURSOR_AGENT_SESSION_TITLE,
      warningMessage: this.buildSessionWarning(cursorChatId),
      startupConfig: {
        cwd: input.cwd,
        model: input.model,
        mode: input.mode,
        permissionMode: input.permissionMode,
        initialPrompt,
      },
      cursorChatId,
      bufferedOutput: "",
    };

    this.sessionsState.updateState((state) => {
      state[sessionId] = newSession;
    });

    if (!sessionName && initialPrompt) {
      this.maybeGenerateTitleFromInitialPrompt(sessionId, initialPrompt);
    }

    return sessionId;
  }

  private maybeGenerateTitleFromInitialPrompt(
    sessionId: string,
    initialPrompt: string,
  ) {
    const prompt = initialPrompt.trim();
    if (!prompt) {
      return;
    }

    this.titleManager.maybeGenerate({
      sessionId,
      prompt,
      sessionExists: () => {
        const session = this.sessionsState.state[sessionId];
        return !!session && session.type === "cursor-agent";
      },
      onTitleReady: (title) => {
        this.sessionsState.updateState((state) => {
          const session = state[sessionId];
          if (!session || session.type !== "cursor-agent") {
            return;
          }
          if (session.title !== DEFAULT_CURSOR_AGENT_SESSION_TITLE) {
            return;
          }
          session.title = title;
        });
      },
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

    const syncBufferedOutput = withDebouncedRunner(() => {
      state.updateState((state) => {
        state[sessionId].bufferedOutput =
          session?.terminal.bufferedOutput ?? "";
      });
    }, 500);
    disposable.addDisposable(() => syncBufferedOutput.dispose());

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

    const activityMonitor =
      cursorChatId && this.cursorHookEventsFilePath
        ? new CursorActivityMonitor({
            onStatusChange: (nextActivityStatus) => {
              activityState = nextActivityStatus;
              setSessionStatus(getCursorSessionStatus(terminal, activityState));
              if (
                nextActivityStatus === "idle" ||
                nextActivityStatus === "awaiting_approval" ||
                nextActivityStatus === "awaiting_user_response"
              ) {
                syncBufferedOutput.flush();
              }
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

    const terminal = createTerminalSession({
      onData: ({ chunk }) => {
        this.eventPublisher.publish(sessionId, {
          type: "data",
          data: chunk,
        });

        syncBufferedOutput.schedule();
      },
      onStatusChange: (status) => {
        setSessionStatus(getCursorSessionStatus(terminal, activityState));
        if (status === "stopped") {
          syncBufferedOutput.flush();
        }
      },
      onExit: (payload) => {
        void this.stopLiveSession(sessionId);
        state.updateState((state) => {
          state[sessionId].status = payload.errorMessage ? "error" : "stopped";
          state[sessionId].errorMessage = payload.errorMessage;
        });
        syncBufferedOutput.flush();
      },
    });
    disposable.addDisposable(() => terminal.stop());
    if (activityMonitor) {
      disposable.addDisposable(() => activityMonitor.stopMonitoring());
    }

    if (activityMonitor && this.cursorHookEventsFilePath && cursorChatId) {
      await activityMonitor.startMonitoring({
        stateFilePath: this.cursorHookEventsFilePath,
        conversationId: cursorChatId,
      });
    }

    terminal.start({
      file: "cursor",
      args: finalArgs,
      runWithShell: true,
      cwd,
      cols,
      rows,
      env: this.cursorConfigDir
        ? {
            CURSOR_CONFIG_DIR: this.cursorConfigDir,
          }
        : undefined,
    });

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
      terminal,
      activityMonitor,
      dispose: disposable.dispose,
    };
    this.liveSessions.set(sessionId, session);
    disposable.addDisposable(() => this.liveSessions.delete(sessionId));
  }

  async stopLiveSession(sessionId: string) {
    const liveSession = this.liveSessions.get(sessionId);
    if (!liveSession) {
      return;
    }
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
      if (!session || session.type !== "cursor-agent") {
        return;
      }
      session.title = nextTitle;
    });

    this.titleManager.forget(sessionId);
  }

  subscribeToTerminalEvents(sessionId: string, signal?: AbortSignal) {
    const liveSession = this.liveSessions.get(sessionId);
    return {
      isLive: !!liveSession,
      bufferedOutput: liveSession?.terminal.bufferedOutput ?? "",
      stream: this.eventPublisher.subscribe(sessionId, { signal }),
    };
  }
}
