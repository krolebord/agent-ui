import { randomUUID } from "node:crypto";
import { EventPublisher } from "@orpc/client";
import { concatAndTruncate, shellQuote } from "@shared/utils";
import { z } from "zod";
import {
  type ClaudeActivityState,
  type ClaudeEffort,
  type ClaudeModel,
  type ClaudePermissionMode,
  claudeEffortSchema,
  claudeModelSchema,
  claudePermissionModeSchema,
} from "../shared/claude-types";
import { defineServiceState } from "../shared/service-state";
import { ClaudeActivityMonitor } from "./claude-activity-monitor";
import { withDebouncedRunner } from "./debounce-runner";
import log from "./logger";
import { procedure } from "./orpc";
import {
  type PersistenceOrchestrator,
  defineStatePersistence,
} from "./persistence-orchestrator";
import type { SessionStateFileManager } from "./session-state-file-manager";
import type { SessionTitleManager } from "./session-title-manager";
import {
  type TerminalSession,
  type TerminalSessionStatus,
  createTerminalSession,
} from "./terminal-session";

const OUTPUT_BUFFER_MAX_TOTAL_SIZE = 1024 * 1024;

interface SessionRecord {
  terminal: TerminalSession;
  activityMonitor: ClaudeActivityMonitor;
  stateFilePath: string;
  bufferedOutput: string;
  dispose: () => Promise<void>;
}

const claudeSessionSchema = z.object({
  sessionId: z.string(),
  title: z.string().catch("Claude Session"),
  createdAt: z.number().default(Date.now()),
  lastActivityAt: z.number().default(Date.now()),

  activity: z.object({
    state: z.literal("unknown" as ClaudeActivityState).catch("unknown"),
    warning: z.string().optional(),
  }),

  terminal: z.object({
    status: z.literal("stopped" as TerminalSessionStatus).catch("stopped"),
    errorMessage: z.string().optional(),
    bufferedOutput: z.string().optional(),
  }),

  startupConfig: z.object({
    permissionMode: claudePermissionModeSchema,
    model: claudeModelSchema,
    effort: claudeEffortSchema.optional(),
    haikuModelOverride: claudeModelSchema.optional().catch(undefined),
    subagentModelOverride: claudeModelSchema.optional().catch(undefined),
    systemPrompt: z.string().optional().catch(undefined),
    initialPrompt: z
      .string()
      .optional()
      .transform((value) => value?.trim()),
    cwd: z.string(),
  }),
});

export type ClaudeSession = z.infer<typeof claudeSessionSchema>;

const defineSessionServiceState = () =>
  defineServiceState({
    key: "sessions",
    defaults: {} as Record<string, ClaudeSession>,
  });

const defineSessionStatePersistence = (state: SessionServiceState) =>
  defineStatePersistence({
    serviceState: state,
    schema: z.record(z.string(), claudeSessionSchema),
  });

export type SessionServiceState = ReturnType<typeof defineSessionServiceState>;

interface SessionServiceOptions {
  persistence: PersistenceOrchestrator;
  pluginDir: string | null;
  pluginWarning: string | null;
  titleManager: SessionTitleManager;
  stateFileManager: SessionStateFileManager;
}

const startClaudeSessionSchema = z.object({
  cwd: z.string(),
  cols: z.number(),
  rows: z.number(),
  sessionName: z
    .string()
    .optional()
    .transform((value) => value?.trim()),
  permissionMode: claudePermissionModeSchema.optional(),
  model: claudeModelSchema.optional(),
  effort: claudeEffortSchema.optional(),
  haikuModelOverride: claudeModelSchema.optional(),
  subagentModelOverride: claudeModelSchema.optional(),
  systemPrompt: z.string().optional(),
  initialPrompt: z
    .string()
    .optional()
    .transform((value) => value?.trim()),
  resumeSessionId: z.string().optional(),
  forkSessionId: z.string().optional(),
});
type StartClaudeSessionInput = z.infer<typeof startClaudeSessionSchema>;

const resumeClaudeSessionSchema = z.object({
  sessionId: z.string(),
  cols: z.number().optional(),
  rows: z.number().optional(),
});
type ResumeClaudeSessionInput = z.infer<typeof resumeClaudeSessionSchema>;

const forkClaudeSessionSchema = z.object({
  sessionId: z.string(),
  cols: z.number().optional(),
  rows: z.number().optional(),
});
type ForkClaudeSessionInput = z.infer<typeof forkClaudeSessionSchema>;

const stopClaudeSessionSchema = z.object({
  sessionId: z.string(),
});

const deleteClaudeSessionSchema = z.object({
  sessionId: z.string(),
});

export const claudeSessionsRouter = {
  startSession: procedure
    .input(startClaudeSessionSchema)
    .handler(async ({ input, context }) => {
      return await context.sessionsService.startNewSession(input);
    }),
  resumeSession: procedure
    .input(resumeClaudeSessionSchema)
    .handler(async ({ input, context }) => {
      return await context.sessionsService.resumeSession(input);
    }),
  forkSession: procedure
    .input(forkClaudeSessionSchema)
    .handler(async ({ input, context }) => {
      return await context.sessionsService.forkSession(input);
    }),
  stopLiveSession: procedure
    .input(stopClaudeSessionSchema)
    .handler(async ({ input, context }) => {
      return await context.sessionsService.stopLiveSession(input.sessionId);
    }),
  deleteSession: procedure
    .input(deleteClaudeSessionSchema)
    .handler(async ({ input, context }) => {
      return await context.sessionsService.deleteSession(input.sessionId);
    }),
  subscribeToSessionTerminal: procedure
    .input(z.object({ sessionId: z.string() }))
    .handler(async function* ({ input, context, signal }) {
      const { bufferedOutput, stream, isLive } =
        context.sessionsService.subscribeToTerminalEvents(
          input.sessionId,
          signal,
        );

      if (isLive) {
        yield { type: "clear" } as TerminalEvent;
        if (bufferedOutput) {
          yield { type: "data", data: bufferedOutput };
        }
      }
      for await (const event of stream) {
        yield event;
      }
    }),
  writeToSessionTerminal: procedure
    .input(z.object({ sessionId: z.string(), data: z.string() }))
    .handler(async ({ input, context }) => {
      const session = context.sessionsService.getLiveSession(input.sessionId);
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
      const session = context.sessionsService.getLiveSession(input.sessionId);
      if (!session) {
        return;
      }
      session.terminal.resize(input.cols, input.rows);
    }),
};

function getPermissionArgs(permissionMode?: ClaudePermissionMode): string {
  if (permissionMode === "yolo") {
    return "--dangerously-skip-permissions";
  }
  if (permissionMode) {
    return `--permission-mode ${permissionMode}`;
  }
  return "";
}

type ClaudeStartOptions =
  | {
      type: "start-new";
      sessionId: string;
      forkSessionId?: string;
    }
  | {
      type: "resume";
      sessionId: string;
    };

type ClaudeStartupOptions = {
  cwd: string;
  permissionMode: ClaudePermissionMode;
  pluginDir: string | null;
  model: ClaudeModel;
  effort?: ClaudeEffort;
  haikuModelOverride?: ClaudeModel;
  subagentModelOverride?: ClaudeModel;
  systemPrompt?: string;
  stateFilePath: string;
  initialPrompt?: string;
  start: ClaudeStartOptions;
};

function buildStartNewArgs(input: ClaudeStartOptions): string[] {
  switch (input.type) {
    case "resume": {
      return [`--resume ${shellQuote(input.sessionId)}`];
    }
    case "start-new": {
      const args = [`--session-id ${shellQuote(input.sessionId)}`];
      if (input.forkSessionId) {
        args.push("--fork-session");
        args.push(`--resume ${shellQuote(input.forkSessionId)}`);
      }
      return args;
    }
  }
}

function buildClaudeArgs(input: ClaudeStartupOptions): {
  args: string[];
  env: Record<string, string>;
} {
  const args: string[] = [];

  const permissionArg = getPermissionArgs(input.permissionMode);
  args.push(permissionArg);

  if (input.pluginDir) {
    args.push(`--plugin-dir ${shellQuote(input.pluginDir)}`);
  }

  if (input.model) {
    args.push(`--model ${input.model}`);
  }

  if (input.effort) {
    args.push(`--effort ${input.effort}`);
  }

  if (input.systemPrompt?.trim()) {
    args.push(`--system-prompt ${shellQuote(input.systemPrompt)}`);
  }

  if (input.initialPrompt?.trim()) {
    args.push(shellQuote(input.initialPrompt));
  }

  args.push(...buildStartNewArgs(input.start));

  const env: Record<string, string> = {
    CLAUDE_UI_STATE_FILE: input.stateFilePath,
    CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "true",
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
    DISABLE_BUG_COMMAND: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_TELEMETRY: "1",
  };

  if (input.haikuModelOverride) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = input.haikuModelOverride;
  }

  if (input.subagentModelOverride) {
    env.CLAUDE_CODE_SUBAGENT_MODEL = input.subagentModelOverride;
  }

  return {
    args: args.filter(Boolean),
    env,
  };
}

function getDefaultSessionTitle(sessionId: string): string {
  return `Session ${sessionId.substring(0, 8)}`;
}

export type TerminalEvent =
  | {
      type: "data";
      data: string;
    }
  | {
      type: "clear";
    };

export class SessionsServiceNew {
  private readonly sessionsState: SessionServiceState;
  private readonly liveSessions = new Map<string, SessionRecord>();
  private readonly eventPublisher = new EventPublisher<
    Record<string, TerminalEvent>
  >({
    maxBufferedEvents: 0,
  });

  private readonly pluginDir: string | null;
  private readonly pluginWarning: string | null;
  private readonly titleManager: SessionTitleManager;
  private readonly stateFileManager: SessionStateFileManager;

  constructor(options: SessionServiceOptions) {
    this.pluginDir = options.pluginDir;
    this.pluginWarning = options.pluginWarning;
    this.titleManager = options.titleManager;
    this.stateFileManager = options.stateFileManager;

    this.sessionsState = defineSessionServiceState();
    options.persistence.registerAndHydrate(
      defineSessionStatePersistence(this.sessionsState),
    );
  }

  getSyncState() {
    return this.sessionsState;
  }

  getSessionById(sessionId: string): ClaudeSession | undefined {
    return this.sessionsState.state[sessionId];
  }

  private createSessionSnapshot(input: {
    sessionId: string;
    title: string;
    startupConfig: ClaudeSession["startupConfig"];
  }): ClaudeSession {
    return {
      sessionId: input.sessionId,
      title: input.title,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      activity: {
        state: "unknown",
        warning: this.pluginWarning ?? undefined,
      },
      terminal: {
        status: "stopped",
      },
      startupConfig: input.startupConfig,
    };
  }

  async startNewSession(sessionInput: StartClaudeSessionInput) {
    const state = this.sessionsState;
    const sessionId = generateUniqueSessionId();
    const sessionName = sessionInput.sessionName?.trim();

    const startupOptions: Omit<ClaudeStartupOptions, "stateFilePath"> = {
      cwd: sessionInput.cwd,
      model: sessionInput.model ?? "opus",
      effort: sessionInput.effort,
      haikuModelOverride: sessionInput.haikuModelOverride,
      subagentModelOverride: sessionInput.subagentModelOverride,
      systemPrompt: sessionInput.systemPrompt,
      permissionMode: sessionInput.permissionMode ?? "default",
      pluginDir: this.pluginDir,
      initialPrompt: sessionInput.initialPrompt,
      start: {
        type: "start-new",
        sessionId,
      },
    };

    const newSession = this.createSessionSnapshot({
      sessionId,
      title: sessionName || getDefaultSessionTitle(sessionId),
      startupConfig: {
        initialPrompt: startupOptions.initialPrompt,
        model: startupOptions.model,
        effort: startupOptions.effort,
        haikuModelOverride: startupOptions.haikuModelOverride,
        subagentModelOverride: startupOptions.subagentModelOverride,
        systemPrompt: startupOptions.systemPrompt,
        permissionMode: startupOptions.permissionMode,
        cwd: startupOptions.cwd,
      },
    });
    state.updateState((state) => {
      state[sessionId] = newSession;
    });

    await this.createLiveSession({
      sessionId,
      cols: sessionInput.cols,
      rows: sessionInput.rows,
      cwd: sessionInput.cwd,
      permissionMode: sessionInput.permissionMode ?? "default",
      model: sessionInput.model ?? "opus",
      effort: sessionInput.effort,
      haikuModelOverride: sessionInput.haikuModelOverride,
      subagentModelOverride: sessionInput.subagentModelOverride,
      systemPrompt: sessionInput.systemPrompt,
      initialPrompt: sessionInput.initialPrompt,
      start: {
        type: "start-new",
        sessionId,
        forkSessionId: sessionInput.forkSessionId,
      },
    });

    const prompt = sessionInput.initialPrompt?.trim();
    if (!sessionName && prompt) {
      this.triggerTitleGeneration(sessionId, prompt);
    }

    return sessionId;
  }

  async resumeSession(input: ResumeClaudeSessionInput) {
    const liveSession = this.liveSessions.get(input.sessionId);
    if (liveSession) {
      return input.sessionId;
    }
    const session = this.getSessionById(input.sessionId);
    if (!session) {
      return input.sessionId;
    }

    await this.createLiveSession({
      sessionId: session.sessionId,
      cols: input.cols,
      rows: input.rows,
      cwd: session.startupConfig.cwd,
      permissionMode: session.startupConfig.permissionMode,
      model: session.startupConfig.model,
      effort: session.startupConfig.effort,
      haikuModelOverride: session.startupConfig.haikuModelOverride,
      subagentModelOverride: session.startupConfig.subagentModelOverride,
      systemPrompt: session.startupConfig.systemPrompt,
      start: {
        type: "resume",
        sessionId: input.sessionId,
      },
    });

    return input.sessionId;
  }

  async forkSession(input: ForkClaudeSessionInput) {
    const state = this.sessionsState;
    const session = this.getSessionById(input.sessionId);
    if (!session) {
      throw new Error(`Session ${input.sessionId} not found`);
    }

    const sessionId = generateUniqueSessionId();
    const forkedSession = this.createSessionSnapshot({
      sessionId,
      title: `${session.title} (fork)`,
      startupConfig: {
        initialPrompt: session.startupConfig.initialPrompt,
        model: session.startupConfig.model,
        effort: session.startupConfig.effort,
        haikuModelOverride: session.startupConfig.haikuModelOverride,
        subagentModelOverride: session.startupConfig.subagentModelOverride,
        systemPrompt: session.startupConfig.systemPrompt,
        permissionMode: session.startupConfig.permissionMode,
        cwd: session.startupConfig.cwd,
      },
    });

    state.updateState((state) => {
      state[sessionId] = forkedSession;
    });

    await this.createLiveSession({
      sessionId,
      cols: input.cols,
      rows: input.rows,
      cwd: session.startupConfig.cwd,
      permissionMode: session.startupConfig.permissionMode,
      model: session.startupConfig.model,
      effort: session.startupConfig.effort,
      haikuModelOverride: session.startupConfig.haikuModelOverride,
      subagentModelOverride: session.startupConfig.subagentModelOverride,
      systemPrompt: session.startupConfig.systemPrompt,
      start: {
        type: "start-new",
        sessionId: sessionId,
        forkSessionId: session.sessionId,
      },
    });
    return sessionId;
  }

  private async createLiveSession(opts: {
    sessionId: string;
    cwd: string;
    cols?: number;
    rows?: number;
    permissionMode: ClaudePermissionMode;
    model: ClaudeModel;
    effort?: ClaudeEffort;
    haikuModelOverride?: ClaudeModel;
    subagentModelOverride?: ClaudeModel;
    systemPrompt?: string;
    initialPrompt?: string;
    start: ClaudeStartOptions;
  }) {
    const disposables: Array<() => Promise<unknown> | unknown> = [];

    const state = this.sessionsState;
    const stateFilePath = await this.stateFileManager.create(opts.sessionId);
    disposables.push(() => this.stateFileManager.cleanup(stateFilePath));

    const syncBufferedOutput = withDebouncedRunner(() => {
      this.sessionsState.updateState((state) => {
        state[opts.sessionId].terminal.bufferedOutput =
          liveSession.bufferedOutput;
      });
    }, 500);
    disposables.push(() => syncBufferedOutput.dispose());

    const activityMonitor = new ClaudeActivityMonitor({
      onStatusChange(status) {
        state.updateState((state) => {
          state[opts.sessionId].activity.state = status;
          state[opts.sessionId].lastActivityAt = Date.now();
        });
        if (
          status === "idle" ||
          status === "awaiting_approval" ||
          status === "awaiting_user_response"
        ) {
          syncBufferedOutput.flush();
        }
      },
      onHookEvent: (event) => {
        if (event.hook_event_name !== "UserPromptSubmit") {
          return;
        }

        const session = state.state[opts.sessionId];
        if (
          !session ||
          session.title !== getDefaultSessionTitle(opts.sessionId)
        ) {
          return;
        }

        const prompt = event.prompt?.trim();
        if (!prompt) {
          return;
        }

        this.triggerTitleGeneration(opts.sessionId, prompt);
      },
    });
    disposables.push(() => activityMonitor.stopMonitoring());

    const { args, env } = buildClaudeArgs({
      start: opts.start,
      permissionMode: opts.permissionMode,
      pluginDir: this.pluginDir,
      model: opts.model,
      effort: opts.effort,
      haikuModelOverride: opts.haikuModelOverride,
      subagentModelOverride: opts.subagentModelOverride,
      systemPrompt: opts.systemPrompt,
      stateFilePath,
      initialPrompt: opts.initialPrompt,
      cwd: opts.cwd,
    });
    const terminal = createTerminalSession({
      onData: (chunk) => {
        this.eventPublisher.publish(opts.sessionId, {
          type: "data",
          data: chunk,
        });

        liveSession.bufferedOutput = concatAndTruncate({
          base: liveSession.bufferedOutput ?? "",
          chunk,
          maxTotalSize: OUTPUT_BUFFER_MAX_TOTAL_SIZE,
        });
        syncBufferedOutput.schedule();
      },
      onExit: (payload) => {
        void this.stopLiveSession(opts.sessionId);
        state.updateState((state) => {
          state[opts.sessionId].terminal.status = payload.errorMessage
            ? "error"
            : "stopped";
          state[opts.sessionId].terminal.errorMessage = payload.errorMessage;
        });
        syncBufferedOutput.flush();
      },
      onStatusChange: (status) => {
        state.updateState((state) => {
          state[opts.sessionId].terminal.status = status;
        });
        if (status === "stopped") {
          syncBufferedOutput.flush();
        }
      },
    });
    disposables.push(() => terminal.stop());

    const liveSession: SessionRecord = {
      terminal,
      activityMonitor,
      stateFilePath,
      bufferedOutput: "",
      dispose: async () => {
        for (const disposable of disposables) {
          try {
            await disposable();
          } catch (error) {
            log.error(`Error disposing of live session ${opts.sessionId}`, {
              error,
            });
          }
        }
      },
    };

    this.liveSessions.set(opts.sessionId, liveSession);
    disposables.push(() => this.liveSessions.delete(opts.sessionId));

    disposables.push(() => this.titleManager.forget(opts.sessionId));

    activityMonitor.startMonitoring(stateFilePath);
    terminal.start({
      cwd: opts.cwd,
      runWithShell: true,
      file: "claude",
      args,
      env,
      cols: opts.cols,
      rows: opts.rows,
    });

    return liveSession;
  }

  private triggerTitleGeneration(sessionId: string, prompt: string) {
    const state = this.sessionsState;
    this.titleManager.maybeGenerate({
      sessionId,
      prompt,
      sessionExists: () => Boolean(state.state[sessionId]),
      onTitleReady: (title) => {
        const nextTitle = title.trim();
        if (!nextTitle) {
          return;
        }

        state.updateState((state) => {
          if (!state[sessionId]) {
            return;
          }

          state[sessionId].title = nextTitle;
        });
      },
    });
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
  }

  getLiveSession(sessionId: string) {
    return this.liveSessions.get(sessionId) ?? null;
  }

  subscribeToTerminalEvents(sessionId: string, signal?: AbortSignal) {
    return {
      isLive: this.liveSessions.has(sessionId),
      bufferedOutput: this.liveSessions.get(sessionId)?.bufferedOutput ?? "",
      stream: this.eventPublisher.subscribe(sessionId, { signal }),
    };
  }
}

function generateUniqueSessionId(): string {
  return randomUUID();
}
