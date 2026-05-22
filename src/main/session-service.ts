import type { TerminalEvent } from "@shared/terminal-types";
import { createDisposable } from "@shared/utils";
import { z } from "zod";
import {
  type ClaudeEffort,
  type ClaudeModel,
  type ClaudePermissionMode,
  claudeEffortSchema,
  claudeModelSchema,
  claudePermissionModeSchema,
} from "../shared/claude-types";
import { ClaudeActivityMonitor } from "./claude-activity-monitor";
import {
  type BuildClaudeArgsInput,
  buildClaudeArgs,
  type ClaudeStartOptions,
} from "./claude-cli";
import { getUsage as getClaudeUsage } from "./claude-usage";
import log from "./logger";
import { procedure } from "./orpc";

import type { SessionStateFileManager } from "./session-state-file-manager";
import {
  commonSessionSchema,
  generateUniqueSessionId,
  type SessionStatus,
} from "./sessions/common";
import type { SessionServiceState } from "./sessions/state";
import { TerminalManager } from "./terminal-manager";
import type { TerminalSessionStatus } from "./terminal-session";
import type { TitleGenerationService } from "./title-generation-service";

interface SessionRecord {
  terminalId: string;
  activityMonitor: ClaudeActivityMonitor;
  stateFilePath: string;
  dispose: () => Promise<void>;
}
interface SessionServiceOptions {
  pluginDir: string | null;
  pluginWarning: string | null;
  terminalManager?: TerminalManager;
  titleGeneration: TitleGenerationService;
  stateFileManager: SessionStateFileManager;
  state: SessionServiceState;
}

export const claudeLocalTerminalSessionSchema = commonSessionSchema.extend({
  type: z.literal("claude-local-terminal"),
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
export type ClaudeLocalTerminalSessionData = z.infer<
  typeof claudeLocalTerminalSessionSchema
>;

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

const renameClaudeSessionSchema = z.object({
  sessionId: z.string(),
  title: z.string().trim().min(1),
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
  renameSession: procedure
    .input(renameClaudeSessionSchema)
    .handler(async ({ input, context }) => {
      context.sessionsService.renameSession(input.sessionId, input.title);
    }),
  getUsage: procedure.handler(getClaudeUsage),
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

type ClaudeStartupOptions = Omit<BuildClaudeArgsInput, "stateFilePath"> & {
  cwd: string;
};

function getDefaultSessionTitle(sessionId: string): string {
  return `Session ${sessionId.substring(0, 8)}`;
}

function getClaudeSessionStatus(
  terminalStatus: TerminalSessionStatus,
  activityMonitor: ClaudeActivityMonitor,
  opts?: { stoppedMeansIdle?: boolean },
): SessionStatus {
  const activityStatus = activityMonitor.getState();

  if (terminalStatus === "starting") return "starting";
  if (terminalStatus === "stopping") return "stopping";
  if (terminalStatus === "error") return "error";
  if (terminalStatus === "stopped")
    return opts?.stoppedMeansIdle ? "idle" : "stopped";

  if (activityStatus === "awaiting_approval") return "awaiting_approval";
  if (activityStatus === "awaiting_user_response")
    return "awaiting_user_response";
  if (activityStatus === "working") return "running";

  return "idle";
}

export type { TerminalEvent } from "@shared/terminal-types";

export class SessionsServiceNew {
  private readonly sessionsState: SessionServiceState;
  private readonly liveSessions = new Map<string, SessionRecord>();

  private readonly pluginDir: string | null;
  private readonly pluginWarning: string | null;
  private readonly titleGeneration: TitleGenerationService;
  private readonly stateFileManager: SessionStateFileManager;
  readonly terminalManager: TerminalManager;

  constructor(options: SessionServiceOptions) {
    this.pluginDir = options.pluginDir;
    this.pluginWarning = options.pluginWarning;
    this.titleGeneration = options.titleGeneration;
    this.stateFileManager = options.stateFileManager;
    this.sessionsState = options.state;
    this.terminalManager = options.terminalManager ?? new TerminalManager();

    for (const [sessionId, session] of Object.entries(
      this.sessionsState.state,
    )) {
      if (session.type === "claude-local-terminal") {
        this.terminalManager.registerTerminal(sessionId);
      }
    }
  }

  private createSessionSnapshot(input: {
    sessionId: string;
    title: string;
    startupConfig: ClaudeLocalTerminalSessionData["startupConfig"];
  }): ClaudeLocalTerminalSessionData {
    return {
      sessionId: input.sessionId,
      type: "claude-local-terminal",
      title: input.title,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "stopped",
      warningMessage: this.pluginWarning ?? undefined,
      startupConfig: input.startupConfig,
    };
  }

  async startNewSession(sessionInput: StartClaudeSessionInput) {
    const state = this.sessionsState;
    const sessionId = generateUniqueSessionId();
    const sessionName = sessionInput.sessionName?.trim();

    const startupOptions: ClaudeStartupOptions = {
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
    this.terminalManager.registerTerminal(sessionId);
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
      this.requestTitleFromPrompt(sessionId, prompt);
    }

    return sessionId;
  }

  private getSessionState(sessionId: string) {
    const session = this.sessionsState.state[sessionId];
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (session.type !== "claude-local-terminal") {
      throw new Error(
        `Session ${sessionId} is not a Claude local terminal session`,
      );
    }
    return session;
  }

  async resumeSession(input: ResumeClaudeSessionInput) {
    const liveSession = this.liveSessions.get(input.sessionId);
    if (liveSession) {
      return input.sessionId;
    }
    const session = this.getSessionState(input.sessionId);

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
    const session = this.getSessionState(input.sessionId);

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

    this.terminalManager.registerTerminal(sessionId);
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
    const state = this.sessionsState;
    const existingLiveSession = this.liveSessions.get(opts.sessionId);
    if (existingLiveSession) {
      return existingLiveSession;
    }

    const disposable = createDisposable({
      onError: (error) => {
        log.error(`Error disposing of live session ${opts.sessionId}`, {
          error,
        });
      },
    });
    const stateFilePath = await this.stateFileManager.create(opts.sessionId);
    disposable.addDisposable(() =>
      this.stateFileManager.cleanup(stateFilePath),
    );

    let deferredPrompt: string | null = null;
    let deferredPromptChecksLeft = 50;
    let effectiveInitialPrompt = opts.initialPrompt;
    if (opts.initialPrompt?.startsWith("/plan ")) {
      const textAfterPlan = opts.initialPrompt.slice("/plan ".length).trim();
      if (textAfterPlan) {
        deferredPrompt = textAfterPlan;
        effectiveInitialPrompt = "/plan";
      }
    }

    const activityMonitor = new ClaudeActivityMonitor({
      onStatusChange: () => {
        const runtime = this.terminalManager.getRuntime(opts.sessionId);
        if (!runtime) {
          return;
        }

        state.updateState((state) => {
          state[opts.sessionId].status = getClaudeSessionStatus(
            runtime.status,
            activityMonitor,
          );
          state[opts.sessionId].lastActivityAt = Date.now();
        });
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

        this.requestTitleFromPrompt(opts.sessionId, prompt);
      },
    });
    disposable.addDisposable(() => activityMonitor.stopMonitoring());
    activityMonitor.startMonitoring(stateFilePath);

    const claudeArgs = buildClaudeArgs({
      start: opts.start,
      permissionMode: opts.permissionMode,
      pluginDir: this.pluginDir,
      model: opts.model,
      effort: opts.effort,
      haikuModelOverride: opts.haikuModelOverride,
      subagentModelOverride: opts.subagentModelOverride,
      systemPrompt: opts.systemPrompt,
      stateFilePath,
      initialPrompt: effectiveInitialPrompt,
    });

    const runtime = this.terminalManager.startTerminal({
      terminalId: opts.sessionId,
      launch: {
        cwd: opts.cwd,
        cols: opts.cols,
        rows: opts.rows,
        runWithShell: true,
        file: "claude",
        args: claudeArgs.args,
        env: claudeArgs.env,
      },
      onData: (chunk) => {
        if (deferredPrompt && deferredPromptChecksLeft > 0) {
          deferredPromptChecksLeft--;
          if (chunk.includes("Enabled")) {
            const prompt = deferredPrompt;
            deferredPrompt = null;
            setTimeout(() => {
              this.terminalManager.writeToTerminal(opts.sessionId, prompt);
              this.terminalManager.writeToTerminal(opts.sessionId, "\r");
            }, 500);
          }
        }
      },
      onStatusChange: (status) => {
        state.updateState((state) => {
          state[opts.sessionId].status = getClaudeSessionStatus(
            status,
            activityMonitor,
          );
          state[opts.sessionId].lastActivityAt = Date.now();
        });
      },
      onExit: (payload) => {
        void this.stopLiveSession(opts.sessionId, payload.snapshot);
        state.updateState((state) => {
          state[opts.sessionId].status = payload.errorMessage
            ? "error"
            : "stopped";
          state[opts.sessionId].errorMessage = payload.errorMessage;
          state[opts.sessionId].offlineBuffer = payload.snapshot;
        });
      },
    });
    disposable.addDisposable(() => runtime.stop());

    const liveSession: SessionRecord = {
      terminalId: opts.sessionId,
      activityMonitor,
      stateFilePath,
      dispose: disposable.dispose,
    };

    this.liveSessions.set(opts.sessionId, liveSession);
    disposable.addDisposable(() => this.liveSessions.delete(opts.sessionId));
    disposable.addDisposable(() => this.titleGeneration.forget(opts.sessionId));

    if (!this.terminalManager.getRuntime(opts.sessionId)) {
      await disposable.dispose();
      return null;
    }

    return liveSession;
  }

  private requestTitleFromPrompt(sessionId: string, prompt: string) {
    const state = this.sessionsState;
    const defaultTitle = getDefaultSessionTitle(sessionId);
    this.titleGeneration.requestFromPrompt({
      sessionId,
      prompt,
      defaultTitle,
      getTitle: () => state.state[sessionId]?.title,
      setTitle: (title) => {
        state.updateState((draft) => {
          const session = draft[sessionId];
          if (!session) {
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
      if (!session || session.type !== "claude-local-terminal") {
        return;
      }
      session.offlineBuffer = offlineBuffer;
    });
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
  }

  renameSession(sessionId: string, title: string) {
    const nextTitle = title.trim();
    if (!nextTitle) {
      return;
    }

    this.sessionsState.updateState((state) => {
      const session = state[sessionId];
      if (!session || session.type !== "claude-local-terminal") {
        return;
      }
      session.title = nextTitle;
    });

    this.titleGeneration.forget(sessionId);
  }

  getLiveSession(sessionId: string) {
    return this.liveSessions.get(sessionId) ?? null;
  }

  subscribeToTerminalEvents(sessionId: string, signal?: AbortSignal) {
    return this.terminalManager.subscribeToTerminalEvents(sessionId, signal);
  }
}
