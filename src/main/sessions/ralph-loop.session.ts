import { readFile, writeFile } from "node:fs/promises";
import { EventPublisher } from "@orpc/server";
import type { TerminalEvent } from "@shared/terminal-types";
import { z } from "zod";
import {
  type ClaudeHookEvent,
  claudeEffortSchema,
  claudeModelSchema,
  claudePermissionModeSchema,
} from "../../shared/claude-types";
import type { ClaudeActivityMonitor } from "../claude-activity-monitor";
import { buildClaudeArgs, type ClaudeStartOptions } from "../claude-cli";
import { getUsage as getClaudeUsage } from "../claude-usage";
import log from "../logger";
import { procedure } from "../orpc";
import type { SessionStateFileManager } from "../session-state-file-manager";
import type { SessionTitleManager } from "../session-title-manager";
import type { TerminalSession } from "../terminal-session";
import { commonSessionSchema, generateUniqueSessionId } from "./common";
import {
  type ClaudeProcessHandle,
  createClaudeProcess,
} from "./start-claude-process";
import type { SessionServiceState } from "./state";

const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_BACKOFF_INITIAL_MS = 3000;
const DEFAULT_BACKOFF_MAX_MS = 60_000;

const loopCompletionSchema = z.enum([
  "not_done",
  "done",
  "max_iterations",
  "stopped_by_user",
  "error",
]);

type LoopCompletion = z.infer<typeof loopCompletionSchema>;

const COMPLETE_TAG_RE = /<\s*complete\s*\/\s*>/i;

export const ralphLoopSessionSchema = commonSessionSchema.extend({
  type: z.literal("ralph-loop"),
  startupConfig: z.object({
    cwd: z.string(),
    objectivePrompt: z.string().catch("Continue working toward the objective."),
    model: claudeModelSchema.catch("opus"),
    effort: claudeEffortSchema.optional().catch(undefined),
    permissionMode: claudePermissionModeSchema.catch("yolo"),
    systemPrompt: z.string().optional().catch(undefined),
    maxIterations: z.number().int().positive().catch(DEFAULT_MAX_ITERATIONS),
    maxConsecutiveFailures: z
      .number()
      .int()
      .nonnegative()
      .catch(DEFAULT_MAX_CONSECUTIVE_FAILURES),
    backoffInitialMs: z
      .number()
      .int()
      .positive()
      .catch(DEFAULT_BACKOFF_INITIAL_MS),
    backoffMaxMs: z.number().int().positive().catch(DEFAULT_BACKOFF_MAX_MS),
  }),
  loopState: z.object({
    autonomousEnabled: z.boolean().catch(true),
    currentIteration: z.number().int().nonnegative().catch(0),
    lastRunAt: z.number().optional().catch(undefined),
    completedAt: z.number().optional().catch(undefined),
    consecutiveFailures: z.number().int().nonnegative().catch(0),
    completion: loopCompletionSchema.catch("not_done"),
    completeDetected: z.boolean().catch(false),
    lastError: z.string().optional().catch(undefined),
  }),
});

export type RalphLoopSessionData = z.infer<typeof ralphLoopSessionSchema>;

const startRalphLoopSessionSchema = z.object({
  cwd: z.string(),
  cols: z.number().optional(),
  rows: z.number().optional(),
  sessionName: z
    .string()
    .optional()
    .transform((value) => value?.trim()),
  objectivePrompt: z.string().min(1),
  model: claudeModelSchema.optional(),
  effort: claudeEffortSchema.optional(),
  permissionMode: claudePermissionModeSchema.optional(),
  systemPrompt: z.string().optional(),
  maxIterations: z.number().int().positive().optional(),
  maxConsecutiveFailures: z.number().int().nonnegative().optional(),
  backoffInitialMs: z.number().int().positive().optional(),
  backoffMaxMs: z.number().int().positive().optional(),
});

const resumeRalphLoopSessionSchema = z.object({
  sessionId: z.string(),
  cols: z.number().optional(),
  rows: z.number().optional(),
});

const singleIterationSchema = z.object({
  sessionId: z.string(),
  cols: z.number().optional(),
  rows: z.number().optional(),
});

const stopLoopSchema = z.object({
  sessionId: z.string(),
});

const deleteLoopSchema = z.object({
  sessionId: z.string(),
});

const renameLoopSessionSchema = z.object({
  sessionId: z.string(),
  title: z.string().trim().min(1),
});

const terminalInputSchema = z.object({
  sessionId: z.string(),
  data: z.string(),
});

const terminalResizeSchema = z.object({
  sessionId: z.string(),
  cols: z.number(),
  rows: z.number(),
});

interface StartIterationInput {
  sessionId: string;
  cols?: number;
  rows?: number;
  mode: "autonomous" | "single";
}

interface RalphLoopSessionRecord {
  terminal: TerminalSession;
  activityMonitor: ClaudeActivityMonitor;
  syncBufferedOutput: ClaudeProcessHandle["syncBufferedOutput"];
  mode: "autonomous" | "single";
  stopHookHandled: boolean;
  stopHookSeen: boolean;
  stopHookTranscriptPath?: string;
}

const DEFAULT_RALPH_LOOP_TITLE_PREFIX = "Ralph Loop ";

interface RalphLoopSessionsManagerOptions {
  pluginDir: string | null;
  state: SessionServiceState;
  stateFileManager: SessionStateFileManager;
  titleManager?: SessionTitleManager;
}

export const ralphLoopRouter = {
  startSession: procedure
    .input(startRalphLoopSessionSchema)
    .handler(async ({ input, context }) => {
      return await context.sessions.ralphLoop.startSession(input);
    }),
  resumeSession: procedure
    .input(resumeRalphLoopSessionSchema)
    .handler(async ({ input, context }) => {
      return await context.sessions.ralphLoop.resumeSession(input);
    }),
  runSingleIteration: procedure
    .input(singleIterationSchema)
    .handler(async ({ input, context }) => {
      await context.sessions.ralphLoop.runSingleIteration(input);
      return { sessionId: input.sessionId };
    }),
  stopLoop: procedure
    .input(stopLoopSchema)
    .handler(async ({ input, context }) => {
      await context.sessions.ralphLoop.stopLoop(input.sessionId);
    }),
  deleteSession: procedure
    .input(deleteLoopSchema)
    .handler(async ({ input, context }) => {
      await context.sessions.ralphLoop.deleteSession(input.sessionId);
    }),
  renameSession: procedure
    .input(renameLoopSessionSchema)
    .handler(async ({ input, context }) => {
      context.sessions.ralphLoop.renameSession(input.sessionId, input.title);
    }),
  getUsage: procedure.handler(getClaudeUsage),
  subscribeToSessionTerminal: procedure
    .input(z.object({ sessionId: z.string() }))
    .handler(async function* ({ input, context, signal }) {
      const { bufferedOutput, stream, isLive } =
        context.sessions.ralphLoop.subscribeToTerminalEvents(
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
    .input(terminalInputSchema)
    .handler(async ({ input, context }) => {
      const session = context.sessions.ralphLoop.liveSessions.get(
        input.sessionId,
      );
      if (!session) {
        return;
      }
      session.terminal.write(input.data);
    }),
  resizeSessionTerminal: procedure
    .input(terminalResizeSchema)
    .handler(async ({ input, context }) => {
      await context.sessions.ralphLoop.resizeSessionTerminal(input);
    }),
};

export class RalphLoopSessionsManager {
  readonly liveSessions = new Map<string, RalphLoopSessionRecord>();
  private readonly eventPublisher = new EventPublisher<
    Record<string, TerminalEvent>
  >({
    maxBufferedEvents: 0,
  });
  private readonly loopTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly stateFilePaths = new Map<string, string>();
  private readonly terminalSizes = new Map<
    string,
    { cols?: number; rows?: number }
  >();
  private readonly manualStopRequested = new Set<string>();

  constructor(private readonly options: RalphLoopSessionsManagerOptions) {}

  async startSession(input: z.infer<typeof startRalphLoopSessionSchema>) {
    if (!this.options.pluginDir) {
      throw new Error(
        "Cannot start ralph-loop session: hook plugin/activity monitor is required but not available. " +
          "Ensure the managed Claude state plugin initialized successfully.",
      );
    }

    const sessionId = generateUniqueSessionId();
    const title =
      input.sessionName?.trim() ||
      `${DEFAULT_RALPH_LOOP_TITLE_PREFIX}${sessionId.slice(0, 8)}`;

    const newSession: RalphLoopSessionData = {
      sessionId,
      type: "ralph-loop",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "stopped",
      title,
      startupConfig: {
        cwd: input.cwd,
        objectivePrompt: input.objectivePrompt.trim(),
        model: input.model ?? "opus",
        effort: input.effort,
        permissionMode: input.permissionMode ?? "yolo",
        systemPrompt: input.systemPrompt?.trim() || undefined,
        maxIterations: input.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        maxConsecutiveFailures:
          input.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES,
        backoffInitialMs: input.backoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS,
        backoffMaxMs: input.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
      },
      loopState: {
        autonomousEnabled: true,
        currentIteration: 0,
        consecutiveFailures: 0,
        completion: "not_done",
        completeDetected: false,
      },
      bufferedOutput: "",
    };

    this.options.state.updateState((state) => {
      state[sessionId] = newSession;
    });

    if (!input.sessionName?.trim()) {
      this.maybeGenerateTitle(sessionId, input.objectivePrompt);
    }

    if (input.cols || input.rows) {
      this.terminalSizes.set(sessionId, {
        cols: input.cols,
        rows: input.rows,
      });
    }

    await this.startIteration({
      sessionId,
      cols: input.cols,
      rows: input.rows,
      mode: "autonomous",
    });

    return { sessionId };
  }

  async resumeSession(input: z.infer<typeof resumeRalphLoopSessionSchema>) {
    const session = this.getSession(input.sessionId);
    if (!session) {
      return;
    }
    const canResumeLoop = canResumeAutonomousLoop(session.loopState.completion);

    if (input.cols || input.rows) {
      this.terminalSizes.set(input.sessionId, {
        cols: input.cols,
        rows: input.rows,
      });
    }

    this.options.state.updateState((state) => {
      const target = state[input.sessionId];
      if (!target || target.type !== "ralph-loop") {
        return;
      }
      target.loopState.autonomousEnabled = canResumeLoop;
      if (target.loopState.completion === "stopped_by_user") {
        target.loopState.completion = "not_done";
      }
      target.loopState.completedAt = undefined;
      if (canResumeLoop) {
        target.loopState.lastError = undefined;
      }
    });

    if (!canResumeLoop) {
      return;
    }

    await this.startIteration({
      sessionId: input.sessionId,
      cols: input.cols,
      rows: input.rows,
      mode: "autonomous",
    });
  }

  async runSingleIteration(input: z.infer<typeof singleIterationSchema>) {
    const session = this.getSession(input.sessionId);
    if (!session) {
      return;
    }

    if (input.cols || input.rows) {
      this.terminalSizes.set(input.sessionId, {
        cols: input.cols,
        rows: input.rows,
      });
    }

    this.options.state.updateState((state) => {
      const target = state[input.sessionId];
      if (!target || target.type !== "ralph-loop") {
        return;
      }
      target.loopState.autonomousEnabled = false;
      target.loopState.completedAt = undefined;
      if (
        target.loopState.completion === "stopped_by_user" ||
        target.loopState.completion === "error"
      ) {
        target.loopState.completion = "not_done";
      }
      target.loopState.lastError = undefined;
    });

    this.clearTimer(input.sessionId);

    await this.startIteration({
      sessionId: input.sessionId,
      cols: input.cols,
      rows: input.rows,
      mode: "single",
    });
  }

  async stopLoop(sessionId: string) {
    this.clearTimer(sessionId);
    this.manualStopRequested.add(sessionId);

    this.options.state.updateState((state) => {
      const session = state[sessionId];
      if (!session || session.type !== "ralph-loop") {
        return;
      }
      session.loopState.autonomousEnabled = false;
      session.loopState.completedAt = Date.now();
      session.loopState.completion = "stopped_by_user";
      session.status = this.liveSessions.has(sessionId)
        ? "stopping"
        : "stopped";
    });

    const live = this.liveSessions.get(sessionId);
    if (live) {
      await live.terminal.stop();
    }
  }

  async deleteSession(sessionId: string) {
    this.clearTimer(sessionId);
    this.manualStopRequested.add(sessionId);

    const live = this.liveSessions.get(sessionId);
    if (live) {
      await live.terminal.stop();
    }

    this.cleanupStateFile(sessionId);
    this.terminalSizes.delete(sessionId);
    this.manualStopRequested.delete(sessionId);

    this.options.titleManager?.forget(sessionId);

    this.options.state.updateState((state) => {
      delete state[sessionId];
    });
  }

  renameSession(sessionId: string, title: string) {
    const nextTitle = title.trim();
    if (!nextTitle) {
      return;
    }

    this.updateSession(sessionId, (session) => {
      session.title = nextTitle;
    });

    this.options.titleManager?.forget(sessionId);
  }

  async resizeSessionTerminal(input: z.infer<typeof terminalResizeSchema>) {
    this.terminalSizes.set(input.sessionId, {
      cols: input.cols,
      rows: input.rows,
    });

    const live = this.liveSessions.get(input.sessionId);
    if (!live) {
      return;
    }
    live.terminal.resize(input.cols, input.rows);
  }

  subscribeToTerminalEvents(sessionId: string, signal?: AbortSignal) {
    const liveSession = this.liveSessions.get(sessionId);
    return {
      isLive: !!liveSession,
      bufferedOutput: this.getSession(sessionId)?.bufferedOutput ?? "",
      stream: this.eventPublisher.subscribe(sessionId, { signal }),
    };
  }

  private maybeGenerateTitle(sessionId: string, objectivePrompt: string) {
    this.options.titleManager?.maybeGenerate({
      sessionId,
      prompt: objectivePrompt,
      sessionExists: () => {
        const session = this.options.state.state[sessionId];
        return !!session && session.type === "ralph-loop";
      },
      onTitleReady: (title) => {
        this.updateSession(sessionId, (session) => {
          if (!session.title.startsWith(DEFAULT_RALPH_LOOP_TITLE_PREFIX)) {
            return;
          }
          session.title = title;
        });
      },
    });
  }

  async dispose() {
    for (const sessionId of this.loopTimers.keys()) {
      this.clearTimer(sessionId);
    }

    const runningSessionIds = [...this.liveSessions.keys()];
    await Promise.allSettled(
      runningSessionIds.map(async (sessionId) => {
        this.manualStopRequested.add(sessionId);
        const live = this.liveSessions.get(sessionId);
        if (!live) {
          return;
        }
        await live.terminal.stop();
      }),
    );

    for (const sessionId of [...this.stateFilePaths.keys()]) {
      this.cleanupStateFile(sessionId);
    }

    this.terminalSizes.clear();
    this.manualStopRequested.clear();
  }

  private clearTimer(sessionId: string) {
    const timer = this.loopTimers.get(sessionId);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.loopTimers.delete(sessionId);
  }

  private getSession(sessionId: string) {
    const session = this.options.state.state[sessionId];
    if (!session || session.type !== "ralph-loop") {
      return null;
    }

    return session;
  }

  private updateSession(
    sessionId: string,
    updater: (session: RalphLoopSessionData) => void,
  ) {
    this.options.state.updateState((state) => {
      const session = state[sessionId];
      if (!session || session.type !== "ralph-loop") {
        return;
      }
      updater(session);
    });
  }

  private async ensureStateFile(sessionId: string): Promise<string> {
    const existing = this.stateFilePaths.get(sessionId);
    if (existing) {
      return existing;
    }

    const stateFilePath = await this.options.stateFileManager.create(sessionId);
    this.stateFilePaths.set(sessionId, stateFilePath);
    return stateFilePath;
  }

  private cleanupStateFile(sessionId: string) {
    const stateFilePath = this.stateFilePaths.get(sessionId);
    if (!stateFilePath) {
      return;
    }

    this.options.stateFileManager.cleanup(stateFilePath);
    this.stateFilePaths.delete(sessionId);
  }

  private async startIteration(input: StartIterationInput) {
    if (this.liveSessions.has(input.sessionId)) {
      return;
    }

    const session = this.getSession(input.sessionId);
    if (!session) {
      return;
    }

    if (
      input.mode === "autonomous" &&
      !canResumeAutonomousLoop(session.loopState.completion)
    ) {
      return;
    }

    this.clearTimer(input.sessionId);

    const iterationNumber = session.loopState.currentIteration + 1;
    const startOpts: ClaudeStartOptions =
      iterationNumber <= 1
        ? {
            type: "start-new",
            sessionId: input.sessionId,
          }
        : {
            type: "resume",
            sessionId: input.sessionId,
          };

    const stateFilePath = await this.ensureStateFile(input.sessionId);
    // Avoid replaying stale hook events (especially old Stop events) across iterations.
    await writeFile(stateFilePath, "", "utf8");

    const prompt = buildRalphLoopPrompt({
      objectivePrompt: session.startupConfig.objectivePrompt,
      iteration: iterationNumber,
    });

    this.updateSession(input.sessionId, (target) => {
      target.status = "starting";
      target.lastActivityAt = Date.now();
      target.loopState.currentIteration = iterationNumber;
      target.loopState.lastRunAt = Date.now();
      target.loopState.completedAt = undefined;
      target.loopState.lastError = undefined;
    });

    const size = this.terminalSizes.get(input.sessionId);

    const handle = createClaudeProcess(
      {
        stateFilePath,
        cwd: session.startupConfig.cwd,
        cols: input.cols ?? size?.cols,
        rows: input.rows ?? size?.rows,
        claudeArgs: buildClaudeArgs({
          start: startOpts,
          permissionMode: session.startupConfig.permissionMode,
          pluginDir: this.options.pluginDir,
          model: session.startupConfig.model,
          effort: session.startupConfig.effort,
          systemPrompt: session.startupConfig.systemPrompt,
          stateFilePath,
          initialPrompt: prompt,
        }),
        syncDebounceMs: 250,
        stoppedMeansIdle: true,
      },
      {
        onSessionStatusChange: (status) => {
          this.updateSession(input.sessionId, (target) => {
            target.status = status;
            target.lastActivityAt = Date.now();
          });
        },
        onBufferedOutputSync: (bufferedOutput) => {
          this.updateSession(input.sessionId, (target) => {
            target.bufferedOutput = bufferedOutput;
          });
        },
        onTerminalData: (chunk) => {
          this.eventPublisher.publish(input.sessionId, {
            type: "data",
            data: chunk,
          });
        },
        onTerminalExit: (payload) => {
          const live = this.liveSessions.get(input.sessionId);
          if (!live) {
            return;
          }

          live.activityMonitor.stopMonitoring();
          live.syncBufferedOutput.flush();
          live.syncBufferedOutput.dispose();
          this.liveSessions.delete(input.sessionId);

          void this.handleIterationExit({
            sessionId: input.sessionId,
            mode: live.mode,
            stopHookSeen: live.stopHookSeen,
            stopHookTranscriptPath: live.stopHookTranscriptPath,
            payload,
          });
        },
        onHookEvent: (event) => {
          if (event.hook_event_name !== "Stop") {
            return;
          }
          this.handleStopHookEvent({
            sessionId: input.sessionId,
            event,
          });
        },
      },
    );

    this.liveSessions.set(input.sessionId, {
      terminal: handle.terminal,
      activityMonitor: handle.activityMonitor,
      syncBufferedOutput: handle.syncBufferedOutput,
      mode: input.mode,
      stopHookHandled: false,
      stopHookSeen: false,
    });

    handle.start();
  }

  private async handleIterationExit(input: {
    sessionId: string;
    mode: "autonomous" | "single";
    stopHookSeen: boolean;
    stopHookTranscriptPath?: string;
    payload: {
      exitCode: number | null;
      signal?: number;
      errorMessage?: string;
    };
  }) {
    const session = this.getSession(input.sessionId);
    if (!session) {
      return;
    }

    const wasManualStop = this.manualStopRequested.has(input.sessionId);
    if (wasManualStop) {
      this.manualStopRequested.delete(input.sessionId);
      this.updateSession(input.sessionId, (target) => {
        target.status = "stopped";
        target.lastActivityAt = Date.now();
        target.loopState.autonomousEnabled = false;
        target.loopState.completedAt = Date.now();
        target.loopState.completion = "stopped_by_user";
        target.loopState.completeDetected = false;
        target.loopState.lastError = input.payload.errorMessage;
      });
      return;
    }

    const prior = this.getSession(input.sessionId);
    if (!prior) {
      return;
    }

    const stopHookOutcome = await evaluateStopHookOutcome({
      stopHookSeen: input.stopHookSeen,
      stopHookTranscriptPath: input.stopHookTranscriptPath,
    });

    // Transcript completion, when present and transcript read succeeded, ends the loop.
    if (
      stopHookOutcome.completeDetected &&
      !stopHookOutcome.transcriptReadFailed
    ) {
      this.updateSession(input.sessionId, (target) => {
        target.status = "stopped";
        target.lastActivityAt = Date.now();
        target.loopState.autonomousEnabled = false;
        target.loopState.completedAt = Date.now();
        target.loopState.completion = "done";
        target.loopState.completeDetected = true;
        target.loopState.lastError = undefined;
      });
      return;
    }

    let iterationFailed = Boolean(input.payload.errorMessage);
    let lastError = input.payload.errorMessage;

    if (stopHookOutcome.transcriptReadFailed) {
      iterationFailed = true;
      lastError =
        stopHookOutcome.transcriptReadError ??
        "Failed reading Stop-hook transcript.";
    }

    const nextConsecutiveFailures = iterationFailed
      ? prior.loopState.consecutiveFailures + 1
      : 0;

    let completion: LoopCompletion = prior.loopState.completion;
    let autonomousEnabled = prior.loopState.autonomousEnabled;
    let status: RalphLoopSessionData["status"] = "idle";

    if (prior.loopState.currentIteration >= prior.startupConfig.maxIterations) {
      completion = "max_iterations";
      autonomousEnabled = false;
      status = "stopped";
    } else if (
      hasReachedConsecutiveFailureLimit(
        nextConsecutiveFailures,
        prior.startupConfig.maxConsecutiveFailures,
      )
    ) {
      completion = "error";
      autonomousEnabled = false;
      status = "error";
    } else if (input.mode === "single") {
      status = iterationFailed ? "error" : "idle";
      autonomousEnabled = false;
      completion = iterationFailed ? "error" : "not_done";
    }

    if (!autonomousEnabled) {
      this.updateSession(input.sessionId, (target) => {
        target.status = status;
        target.lastActivityAt = Date.now();
        target.loopState.autonomousEnabled = autonomousEnabled;
        target.loopState.completedAt = Date.now();
        target.loopState.completion = completion;
        target.loopState.consecutiveFailures = nextConsecutiveFailures;
        target.loopState.completeDetected = false;
        target.loopState.lastError = lastError;
      });
      return;
    }

    const delayMs = iterationFailed
      ? Math.min(
          prior.startupConfig.backoffInitialMs *
            2 ** Math.max(0, nextConsecutiveFailures - 1),
          prior.startupConfig.backoffMaxMs,
        )
      : 0;

    this.updateSession(input.sessionId, (target) => {
      target.status = "idle";
      target.lastActivityAt = Date.now();
      target.loopState.autonomousEnabled = true;
      target.loopState.completion = "not_done";
      target.loopState.completedAt = undefined;
      target.loopState.consecutiveFailures = nextConsecutiveFailures;
      target.loopState.completeDetected = false;
      target.loopState.lastError = lastError;
    });

    const timer = setTimeout(() => {
      this.loopTimers.delete(input.sessionId);
      void this.startIteration({
        sessionId: input.sessionId,
        mode: "autonomous",
      }).catch((error) => {
        log.error("Failed to schedule next ralph-loop iteration", {
          sessionId: input.sessionId,
          error,
        });
        this.updateSession(input.sessionId, (target) => {
          target.status = "error";
          target.loopState.completion = "error";
          target.loopState.autonomousEnabled = false;
          target.loopState.completedAt = Date.now();
          target.loopState.lastError =
            error instanceof Error ? error.message : "Unknown loop error";
        });
      });
    }, delayMs);

    this.loopTimers.set(input.sessionId, timer);
  }

  private handleStopHookEvent({
    sessionId,
    event,
  }: {
    sessionId: string;
    event: ClaudeHookEvent;
  }) {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      return;
    }
    if (live.stopHookHandled) {
      return;
    }
    live.stopHookHandled = true;

    if (this.manualStopRequested.has(sessionId)) {
      return;
    }

    live.stopHookSeen = true;
    live.stopHookTranscriptPath =
      extractTranscriptPathFromStopHook(event) ?? undefined;

    if (
      live.terminal.status !== "stopping" &&
      live.terminal.status !== "stopped"
    ) {
      void live.terminal.stop();
    }
  }
}

export function canResumeAutonomousLoop(completion: LoopCompletion): boolean {
  return completion !== "done" && completion !== "max_iterations";
}

export function hasReachedConsecutiveFailureLimit(
  nextConsecutiveFailures: number,
  maxConsecutiveFailures: number,
): boolean {
  return nextConsecutiveFailures >= maxConsecutiveFailures;
}

export function buildRalphLoopPrompt(input: {
  objectivePrompt: string;
  iteration: number;
}): string {
  return input.objectivePrompt
    .replace("{iteration}", input.iteration.toString())
    .replace("{complete_marker}", "<COMPLETE/>")
    .trim();
}

export function extractTranscriptPathFromStopHook(
  event: ClaudeHookEvent,
): string | null {
  if (event.hook_event_name !== "Stop") {
    return null;
  }

  const transcriptPath = event.transcript_path?.trim();
  if (!transcriptPath) {
    return null;
  }

  return transcriptPath;
}

export function hasCompleteMarkerInAssistantText(text: string): boolean {
  return COMPLETE_TAG_RE.test(text);
}

type AssistantTextReadResult =
  | { success: true; text: string }
  | { success: false; error: string };

type StopHookEvaluationResult = {
  completeDetected: boolean;
  transcriptReadFailed: boolean;
  transcriptReadError?: string;
};

export async function evaluateStopHookOutcome(input: {
  stopHookSeen: boolean;
  stopHookTranscriptPath?: string;
}): Promise<StopHookEvaluationResult> {
  if (!input.stopHookSeen) {
    return {
      completeDetected: false,
      transcriptReadFailed: false,
    };
  }

  if (!input.stopHookTranscriptPath) {
    return {
      completeDetected: false,
      transcriptReadFailed: true,
      transcriptReadError:
        "Stop hook event missing transcript_path; cannot evaluate completion marker.",
    };
  }

  const assistantTextResult = await readLastAssistantTextFromTranscript(
    input.stopHookTranscriptPath,
  );
  if (!assistantTextResult.success) {
    return {
      completeDetected: false,
      transcriptReadFailed: true,
      transcriptReadError: assistantTextResult.error,
    };
  }

  return {
    completeDetected: hasCompleteMarkerInAssistantText(
      assistantTextResult.text,
    ),
    transcriptReadFailed: false,
  };
}

export async function readLastAssistantTextFromTranscript(
  transcriptPath: string,
): Promise<AssistantTextReadResult> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? `Failed reading transcript file: ${error.message}`
          : "Failed reading transcript file.",
    };
  }

  const lines = raw.split(/\r?\n/);
  let lastAssistant: unknown = null;
  let parseErrors = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as { type?: unknown }).type === "assistant"
      ) {
        lastAssistant = parsed;
      }
    } catch {
      parseErrors++;
    }
  }

  if (parseErrors > 0) {
    return {
      success: false,
      error: "Transcript contains invalid JSONL.",
    };
  }

  if (!lastAssistant) {
    return {
      success: false,
      error: "No assistant entry found in transcript.",
    };
  }

  const message = (lastAssistant as { message?: unknown }).message;
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return { success: true, text: "" };
  }

  const text = content
    .filter(
      (item): item is { type: string; text: string } =>
        Boolean(item) &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => item.text)
    .join("\n");

  return { success: true, text };
}
