import { call, EventPublisher } from "@orpc/server";
import {
  type CodexModelReasoningEffort,
  type CodexPermissionMode,
  codexModelReasoningEffortSchema,
} from "@shared/codex-types";
import type { TerminalEvent } from "@shared/terminal-types";
import { createDisposable } from "@shared/utils";
import { z } from "zod";
import { buildCodexArgs } from "../codex-cli";
import type { CodexSessionLogFileManager } from "../codex-session-log-file-manager";
import { getCodexUsage } from "../codex-usage";
import { withDebouncedRunner } from "../debounce-runner";
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

const DEFAULT_CODEX_SESSION_TITLE = "Codex Session";

export const codexLocalTerminalSessionSchema = commonSessionSchema.extend({
  type: z.literal("codex-local-terminal"),
  startupConfig: z.object({
    cwd: z.string(),
    model: z.string().optional(),
    modelReasoningEffort: codexModelReasoningEffortSchema.default("high"),
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

      context.sessions.codex.startLiveSession({
        sessionId,
        cwd: session.startupConfig.cwd,
        model: session.startupConfig.model,
        modelReasoningEffort: session.startupConfig.modelReasoningEffort,
        permissionMode: session.startupConfig
          .permissionMode as CodexPermissionMode,
        initialPrompt: session.startupConfig.initialPrompt,
        configOverrides: session.startupConfig.configOverrides,
        cols: input.cols,
        rows: input.rows,
      });

      return { sessionId };
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
      const { bufferedOutput, stream, isLive } =
        context.sessions.codex.subscribeToTerminalEvents(
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
      const session = context.sessions.codex.liveSessions.get(input.sessionId);
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
      const session = context.sessions.codex.liveSessions.get(input.sessionId);
      if (!session) {
        return;
      }
      session.terminal.resize(input.cols, input.rows);
    }),
};

interface CodexSessionRecord {
  terminal: TerminalSession;
  dispose: () => Promise<void>;
}

interface CodexSessionsManagerOptions {
  state: SessionServiceState;
  titleManager?: SessionTitleManager;
  sessionLogFileManager?: CodexSessionLogFileManager;
}

export class CodexSessionsManager {
  readonly liveSessions = new Map<string, CodexSessionRecord>();
  private readonly eventPublisher = new EventPublisher<
    Record<string, TerminalEvent>
  >({
    maxBufferedEvents: 0,
  });
  private readonly sessionsState: SessionServiceState;
  private readonly titleManager: SessionTitleManager;
  private readonly sessionLogFileManager: CodexSessionLogFileManager | null;

  constructor(options: CodexSessionsManagerOptions | SessionServiceState) {
    if ("updateState" in options) {
      this.sessionsState = options;
      this.titleManager = new SessionTitleManager();
      this.sessionLogFileManager = null;
      return;
    }

    this.sessionsState = options.state;
    this.titleManager = options.titleManager ?? new SessionTitleManager();
    this.sessionLogFileManager = options.sessionLogFileManager ?? null;
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
      startupConfig: {
        cwd: input.cwd,
        model: input.model,
        modelReasoningEffort: input.modelReasoningEffort,
        permissionMode: input.permissionMode,
        initialPrompt,
        configOverrides: input.configOverrides,
      },
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
    const prompt = /^\/plan(?:\s+|$)/.test(initialPrompt)
      ? initialPrompt.replace(/^\/plan(?:\s+)?/, "").trim()
      : initialPrompt;
    if (!prompt) {
      return;
    }

    this.titleManager.maybeGenerate({
      sessionId,
      prompt,
      sessionExists: () => {
        const session = this.sessionsState.state[sessionId];
        return !!session && session.type === "codex-local-terminal";
      },
      onTitleReady: (title) => {
        this.sessionsState.updateState((state) => {
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

  startLiveSession({
    sessionId,
    cwd,
    model,
    modelReasoningEffort,
    permissionMode,
    initialPrompt,
    configOverrides,
    cols,
    rows,
  }: {
    sessionId: string;
    cwd: string;
    model?: string;
    modelReasoningEffort: CodexModelReasoningEffort;
    permissionMode: CodexPermissionMode;
    initialPrompt?: string;
    configOverrides?: string;
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
        log.error("Error starting codex live session", error);
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
      });
    };

    // Determine if we need plan mode (deferred prompt)
    const isPlanMode = initialPrompt?.startsWith("/plan ");
    let shouldSwitchToPlanMode = isPlanMode;
    const deferredPrompt =
      (isPlanMode
        ? initialPrompt?.substring("/plan ".length).trim()
        : undefined) || undefined;

    const { args } = buildCodexArgs({
      permissionMode,
      model,
      modelReasoningEffort,
      configOverrides,
      initialPrompt: isPlanMode ? undefined : initialPrompt,
    });

    const sessionLogPath = this.createSessionLogPath(sessionId);
    if (sessionLogPath) {
      disposable.addDisposable(() => {
        this.sessionLogFileManager?.cleanup(sessionLogPath);
      });
    }

    const terminal = createTerminalSession({
      onData: ({ chunk }) => {
        this.eventPublisher.publish(sessionId, {
          type: "data",
          data: chunk,
        });

        syncBufferedOutput.schedule();
      },
      onStatusChange: (status) => {
        setSessionStatus(status === "running" ? "idle" : status);
        if (status === "stopped") {
          syncBufferedOutput.flush();
        }

        // Plan mode: once terminal emits data, wait for plan prompt hints before submitting.
        if (status === "running" && shouldSwitchToPlanMode) {
          shouldSwitchToPlanMode = false;

          if (deferredPrompt) {
            setTimeout(() => {
              terminal.write("\x1b[Z");
              terminal.write(`${deferredPrompt}`);
              setTimeout(() => {
                terminal.write("\x1b[13u");
              }, 100);
            }, 100);
          }
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

    terminal.start({
      file: "codex",
      args,
      runWithShell: true,
      cwd,
      cols,
      rows,
      env: sessionLogPath
        ? {
            CODEX_TUI_RECORD_SESSION: "1",
            CODEX_TUI_SESSION_LOG_PATH: sessionLogPath,
          }
        : undefined,
    });

    const session: CodexSessionRecord = {
      terminal,
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
      if (!session || session.type !== "codex-local-terminal") {
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

  private createSessionLogPath(sessionId: string): string | null {
    if (!this.sessionLogFileManager) {
      return null;
    }

    try {
      return this.sessionLogFileManager.create(sessionId);
    } catch (error) {
      log.error("Failed to initialize codex session log file", {
        sessionId,
        error,
      });
      return null;
    }
  }
}
