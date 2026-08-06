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
  type ClaudeAccountAuth,
  type ClaudeStartOptions,
} from "./claude-cli";
import {
  fetchUsageWithToken,
  getUsage as getClaudeUsage,
} from "./claude-usage";
import {
  createInMemorySessionBufferStore,
  type SessionBufferStore,
} from "./database/session-buffer-store";
import log from "./logger";
import type { McpRequestContext } from "./mcp/session-token";
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
  beginDispose: () => void;
  dispose: () => Promise<void>;
}
interface SessionServiceOptions {
  pluginDir: string | null;
  pluginWarning: string | null;
  terminalManager?: TerminalManager;
  titleGeneration: TitleGenerationService;
  stateFileManager: SessionStateFileManager;
  state: SessionServiceState;
  getMcpServerUrl?: (context: McpRequestContext) => string | null;
  getAccountAuth?: (accountId: string) => Promise<ClaudeAccountAuth | null>;
  sessionBuffers?: SessionBufferStore;
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
    remoteControl: z.boolean().optional().catch(undefined),
    mcpEnabled: z.boolean().optional().catch(undefined),
    mcpCanScheduleSessions: z.boolean().optional().catch(undefined),
    accountId: z.string().optional().catch(undefined),
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

export const startClaudeSessionSchema = z.object({
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
  remoteControl: z.boolean().optional(),
  mcpEnabled: z.boolean().optional(),
  mcpCanScheduleSessions: z.boolean().optional(),
  accountId: z.string().optional(),
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
  remoteControl: z.boolean().optional(),
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

function claudeSessionCwd(
  state: SessionServiceState,
  sessionId: string,
): string | null {
  const session = state.state[sessionId];
  return session?.type === "claude-local-terminal"
    ? session.startupConfig.cwd
    : null;
}

export const claudeSessionsRouter = {
  startSession: procedure
    .input(startClaudeSessionSchema)
    .handler(async ({ input, context }) => {
      await context.skillsService.ensureFreshForPath(input.cwd);
      return await context.sessionsService.startNewSession(input);
    }),
  resumeSession: procedure
    .input(resumeClaudeSessionSchema)
    .handler(async ({ input, context }) => {
      await context.skillsService.ensureFreshForPath(
        claudeSessionCwd(context.sessions.state, input.sessionId),
      );
      return await context.sessionsService.resumeSession(input);
    }),
  forkSession: procedure
    .input(forkClaudeSessionSchema)
    .handler(async ({ input, context }) => {
      await context.skillsService.ensureFreshForPath(
        claudeSessionCwd(context.sessions.state, input.sessionId),
      );
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
  getUsage: procedure
    .input(z.object({ accountId: z.string().optional() }).optional())
    .handler(async ({ input, context }) => {
      const accountId = input?.accountId;
      if (!accountId) {
        return await getClaudeUsage();
      }

      // An explicit account bypasses the global API-billing env guard: the
      // account's own credentials decide, not the host environment.
      const account = context.claudeAccounts.getAccount(accountId);
      if (!account) {
        return { ok: false, message: "Claude account not found" };
      }
      if (account.type === "setup-token") {
        return {
          ok: false,
          message:
            "Usage is unavailable for setup-token accounts (missing scope)",
        };
      }

      let accessToken: string;
      try {
        accessToken =
          await context.claudeAccounts.getValidAccessToken(accountId);
      } catch (error) {
        return {
          ok: false,
          message:
            error instanceof Error ? error.message : "Token refresh failed",
        };
      }
      return await fetchUsageWithToken(accessToken);
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

type ClaudeStartupOptions = Omit<
  BuildClaudeArgsInput,
  "stateFilePath" | "mcpServerUrl" | "accountAuth"
> & {
  cwd: string;
  mcpEnabled?: boolean;
  mcpCanScheduleSessions?: boolean;
  accountId?: string;
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
  private readonly getMcpServerUrl:
    | ((context: McpRequestContext) => string | null)
    | null;
  private readonly getAccountAuth:
    | ((accountId: string) => Promise<ClaudeAccountAuth | null>)
    | null;
  readonly terminalManager: TerminalManager;
  private readonly sessionBuffers: SessionBufferStore;

  constructor(options: SessionServiceOptions) {
    this.pluginDir = options.pluginDir;
    this.pluginWarning = options.pluginWarning;
    this.getMcpServerUrl = options.getMcpServerUrl ?? null;
    this.getAccountAuth = options.getAccountAuth ?? null;
    this.titleGeneration = options.titleGeneration;
    this.stateFileManager = options.stateFileManager;
    this.sessionsState = options.state;
    this.terminalManager = options.terminalManager ?? new TerminalManager();
    this.sessionBuffers =
      options.sessionBuffers ?? createInMemorySessionBufferStore();

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
      remoteControl: sessionInput.remoteControl,
      mcpEnabled: sessionInput.mcpEnabled,
      mcpCanScheduleSessions: sessionInput.mcpCanScheduleSessions,
      accountId: sessionInput.accountId,
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
        remoteControl: startupOptions.remoteControl,
        mcpEnabled: startupOptions.mcpEnabled,
        mcpCanScheduleSessions: startupOptions.mcpCanScheduleSessions,
        accountId: startupOptions.accountId,
        permissionMode: startupOptions.permissionMode,
        cwd: startupOptions.cwd,
      },
    });
    this.terminalManager.registerTerminal(sessionId);
    state.updateState((state) => {
      state[sessionId] = newSession;
    });

    try {
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
        remoteControl: sessionInput.remoteControl,
        mcpEnabled: sessionInput.mcpEnabled,
        mcpCanScheduleSessions: sessionInput.mcpCanScheduleSessions,
        accountId: sessionInput.accountId,
        initialPrompt: sessionInput.initialPrompt,
        start: {
          type: "start-new",
          sessionId,
          forkSessionId: sessionInput.forkSessionId,
        },
      });
    } catch (error) {
      await this.discardUnstartedSession(sessionId);
      throw error;
    }

    const prompt = sessionInput.initialPrompt?.trim();
    if (!sessionName && prompt) {
      this.requestTitleFromPrompt(sessionId, prompt);
    }

    return sessionId;
  }

  /**
   * Drops a session record that never made it to a running terminal, so a
   * failed start (e.g. an account that needs a fresh login) doesn't leave a
   * dead entry in the sidebar.
   */
  private async discardUnstartedSession(sessionId: string) {
    await this.terminalManager.unregisterTerminal(sessionId);
    this.sessionsState.updateState((state) => {
      delete state[sessionId];
    });
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

    if (
      input.remoteControl !== undefined &&
      input.remoteControl !== session.startupConfig.remoteControl
    ) {
      this.sessionsState.updateState((state) => {
        const draft = state[input.sessionId];
        if (draft?.type === "claude-local-terminal") {
          draft.startupConfig.remoteControl = input.remoteControl;
        }
      });
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
      remoteControl: input.remoteControl ?? session.startupConfig.remoteControl,
      mcpEnabled: session.startupConfig.mcpEnabled,
      mcpCanScheduleSessions: session.startupConfig.mcpCanScheduleSessions,
      accountId: session.startupConfig.accountId,
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
        remoteControl: session.startupConfig.remoteControl,
        mcpEnabled: session.startupConfig.mcpEnabled,
        mcpCanScheduleSessions: session.startupConfig.mcpCanScheduleSessions,
        accountId: session.startupConfig.accountId,
        permissionMode: session.startupConfig.permissionMode,
        cwd: session.startupConfig.cwd,
      },
    });

    this.terminalManager.registerTerminal(sessionId);
    state.updateState((state) => {
      state[sessionId] = forkedSession;
    });

    try {
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
        remoteControl: session.startupConfig.remoteControl,
        mcpEnabled: session.startupConfig.mcpEnabled,
        mcpCanScheduleSessions: session.startupConfig.mcpCanScheduleSessions,
        accountId: session.startupConfig.accountId,
        start: {
          type: "start-new",
          sessionId: sessionId,
          forkSessionId: session.sessionId,
        },
      });
    } catch (error) {
      await this.discardUnstartedSession(sessionId);
      throw error;
    }
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
    remoteControl?: boolean;
    mcpEnabled?: boolean;
    mcpCanScheduleSessions?: boolean;
    accountId?: string;
    initialPrompt?: string;
    start: ClaudeStartOptions;
  }) {
    const state = this.sessionsState;
    const existingLiveSession = this.liveSessions.get(opts.sessionId);
    if (existingLiveSession) {
      return existingLiveSession;
    }

    // Resolved before anything is allocated: a managed account whose token
    // cannot be refreshed throws, and the session must not start under the
    // default account by accident.
    let accountAuth: ClaudeAccountAuth | undefined;
    if (opts.accountId) {
      accountAuth = (await this.getAccountAuth?.(opts.accountId)) ?? undefined;
      if (!accountAuth) {
        log.warn(
          `Claude account ${opts.accountId} for session ${opts.sessionId} was not found; starting with the default account`,
        );
      }
    }

    const disposable = createDisposable({
      onError: (error) => {
        log.error(`Error disposing of live session ${opts.sessionId}`, {
          error,
        });
      },
    });
    let isDisposing = false;
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
        if (isDisposing) {
          return;
        }
        const runtime = this.terminalManager.getRuntime(opts.sessionId);
        if (!runtime) {
          return;
        }

        state.updateState((state) => {
          state[opts.sessionId].status = getClaudeSessionStatus(
            runtime.status,
            activityMonitor,
          );
          // Teardown statuses are finalized by onExit for activity purposes.
          if (runtime.status === "starting" || runtime.status === "running") {
            state[opts.sessionId].lastActivityAt = Date.now();
          }
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
    const beginDispose = () => {
      if (isDisposing) {
        return;
      }
      isDisposing = true;
      // Stop hook delivery before terminal teardown. Preserving the last state
      // avoids turning an internal reset to `unknown` into activity.
      activityMonitor.stopMonitoring({ preserveState: true });
    };
    disposable.addDisposable(beginDispose);
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
      remoteControl: opts.remoteControl,
      accountAuth,
      stateFilePath,
      initialPrompt: effectiveInitialPrompt,
      mcpServerUrl:
        opts.mcpEnabled === false
          ? null
          : (this.getMcpServerUrl?.({
              sessionId: opts.sessionId,
              cwd: opts.cwd,
              canScheduleSessions: opts.mcpCanScheduleSessions !== false,
            }) ?? null),
    });

    const runtime = await this.terminalManager.startTerminal({
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
          // Intentional stop transitions through stopping/stopped/error without
          // counting as activity; crashes bump from onExit instead.
          if (status === "starting" || status === "running") {
            state[opts.sessionId].lastActivityAt = Date.now();
          }
        });
      },
      onExit: (payload) => {
        void this.stopLiveSession(opts.sessionId, payload.snapshot);
        state.updateState((state) => {
          state[opts.sessionId].status = payload.errorMessage
            ? "error"
            : "stopped";
          state[opts.sessionId].errorMessage = payload.errorMessage;
          // Unexpected exits wake parked sessions. User-initiated stops
          // (including settle) must not, or the row flashes out of Settled.
          if (!payload.stoppedByUser) {
            state[opts.sessionId].lastActivityAt = Date.now();
          }
        });
      },
    });
    disposable.addDisposable(() => runtime.stop());

    const liveSession: SessionRecord = {
      terminalId: opts.sessionId,
      activityMonitor,
      stateFilePath,
      beginDispose,
      dispose: disposable.dispose,
    };

    this.liveSessions.set(opts.sessionId, liveSession);
    disposable.addDisposable(() => this.liveSessions.delete(opts.sessionId));
    disposable.addDisposable(() => this.titleGeneration.forget(opts.sessionId));

    if (!this.terminalManager.getRuntime(opts.sessionId)) {
      liveSession.beginDispose();
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

  private async persistOfflineBuffer(
    sessionId: string,
    offlineBuffer?: string,
  ) {
    if (!offlineBuffer) {
      return;
    }

    const session = this.sessionsState.state[sessionId];
    if (session?.type !== "claude-local-terminal") {
      return;
    }

    await this.sessionBuffers.set(sessionId, offlineBuffer);
  }

  async stopLiveSession(sessionId: string, offlineBuffer?: string) {
    const liveSession = this.liveSessions.get(sessionId);
    if (!liveSession) {
      return;
    }
    liveSession.beginDispose();
    await this.persistOfflineBuffer(
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
    await this.sessionBuffers.delete(sessionId);

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
      if (session?.type !== "claude-local-terminal") {
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
