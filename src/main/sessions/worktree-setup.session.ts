import spawn from "nano-spawn";
import { z } from "zod";
import { withDebouncedRunner } from "../debounce-runner";
import log from "../logger";
import { procedure } from "../orpc";
import {
  commonSessionSchema,
  generateUniqueSessionId,
  type SessionStatus,
  sessionStatusSchema,
} from "./common";
import type { SessionServiceState } from "./state";

/** Max characters stored per command output (10 KiB). */
export const WORKTREE_SETUP_MAX_OUTPUT_CHARS = 10 * 1024;

const OUTPUT_TRUNCATED_SUFFIX = "\n… [truncated]";

export function parseSetupCommands(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function truncateToMax(
  value: string,
  max: number,
): { text: string; truncated: boolean } {
  if (value.length <= max) {
    return { text: value, truncated: false };
  }
  const budget = max - OUTPUT_TRUNCATED_SUFFIX.length;
  if (budget <= 0) {
    return { text: OUTPUT_TRUNCATED_SUFFIX.slice(0, max), truncated: true };
  }
  return {
    text: value.slice(0, budget) + OUTPUT_TRUNCATED_SUFFIX,
    truncated: true,
  };
}

function appendOutputLine(
  current: string,
  line: string,
): { text: string; truncated: boolean } {
  const next = current ? `${current}\n${line}` : line;
  return truncateToMax(next, WORKTREE_SETUP_MAX_OUTPUT_CHARS);
}

const worktreeSetupStepSchema = z.object({
  command: z.string(),
  status: z.enum(["pending", "running", "success", "error"]),
  output: z.string(),
  errorMessage: z.string().optional(),
  outputTruncated: z.boolean().optional(),
});

export const worktreeSetupSessionSchema = commonSessionSchema
  .omit({ status: true })
  .extend({
    type: z.literal("worktree-setup"),
    status: sessionStatusSchema.catch("running"),
    startupConfig: z.object({
      cwd: z.string(),
      projectRoot: z.string(),
    }),
    steps: z.array(worktreeSetupStepSchema),
  });

export type WorktreeSetupSessionData = z.infer<
  typeof worktreeSetupSessionSchema
>;

const renameWorktreeSetupSessionSchema = z.object({
  sessionId: z.string(),
  title: z.string().trim().min(1),
});

export const worktreeSetupSessionsRouter = {
  deleteSession: procedure
    .input(z.object({ sessionId: z.string() }))
    .handler(async ({ input, context }) => {
      await context.sessions.worktreeSetup.deleteSession(input.sessionId);
    }),
  renameSession: procedure
    .input(renameWorktreeSetupSessionSchema)
    .handler(async ({ input, context }) => {
      context.sessions.worktreeSetup.renameSession(
        input.sessionId,
        input.title,
      );
    }),
  cancelSetup: procedure
    .input(z.object({ sessionId: z.string() }))
    .handler(async ({ input, context }) => {
      context.sessions.worktreeSetup.cancelSetup(input.sessionId);
    }),
};

export class WorktreeSetupSessionsManager {
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(
    private readonly sessionsState: SessionServiceState,
    private readonly disposeSignal: AbortSignal,
  ) {
    this.disposeSignal.addEventListener(
      "abort",
      () => {
        for (const id of [...this.abortControllers.keys()]) {
          this.cancelSetup(id);
        }
      },
      { once: true },
    );
  }

  createSessionAndStart(input: {
    cwd: string;
    projectRoot: string;
    commands: string[];
  }): string {
    const sessionId = generateUniqueSessionId();
    const steps: WorktreeSetupSessionData["steps"] = input.commands.map(
      (command) => ({
        command,
        status: "pending",
        output: "",
      }),
    );

    const newSession: WorktreeSetupSessionData = {
      sessionId,
      type: "worktree-setup",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "running",
      title: "Worktree setup",
      startupConfig: {
        cwd: input.cwd,
        projectRoot: input.projectRoot,
      },
      steps,
    };

    this.sessionsState.updateState((sessions) => {
      sessions[sessionId] = newSession;
    });

    const controller = new AbortController();
    this.abortControllers.set(sessionId, controller);

    void this.runSetup(
      sessionId,
      input.projectRoot,
      input.cwd,
      controller.signal,
    );

    return sessionId;
  }

  cancelSetup(sessionId: string): void {
    const controller = this.abortControllers.get(sessionId);
    controller?.abort();
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.cancelSetup(sessionId);
    this.abortControllers.delete(sessionId);
    this.sessionsState.updateState((sessions) => {
      delete sessions[sessionId];
    });
  }

  renameSession(sessionId: string, title: string): void {
    const nextTitle = title.trim();
    if (!nextTitle) {
      return;
    }

    this.sessionsState.updateState((sessions) => {
      const session = sessions[sessionId];
      if (session?.type !== "worktree-setup") {
        return;
      }
      session.title = nextTitle;
    });
  }

  async dispose(): Promise<void> {
    for (const id of [...this.abortControllers.keys()]) {
      this.cancelSetup(id);
    }
  }

  private async runSetup(
    sessionId: string,
    projectRoot: string,
    worktreeRoot: string,
    signal: AbortSignal,
  ): Promise<void> {
    const env = {
      ...process.env,
      PROJECT_ROOT: projectRoot,
      WORKTREE_ROOT: worktreeRoot,
    };

    const patchStep = (
      stepIndex: number,
      patch: Partial<WorktreeSetupSessionData["steps"][number]>,
    ) => {
      this.sessionsState.updateState((sessions) => {
        const session = sessions[sessionId];
        if (session?.type !== "worktree-setup") {
          return;
        }
        Object.assign(session.steps[stepIndex], patch);
        session.lastActivityAt = Date.now();
      });
    };

    const setSessionDone = (finalStatus: SessionStatus) => {
      this.sessionsState.updateState((sessions) => {
        const session = sessions[sessionId];
        if (session?.type !== "worktree-setup") {
          return;
        }
        session.status = finalStatus;
        session.lastActivityAt = Date.now();
      });
      this.abortControllers.delete(sessionId);
    };

    try {
      const session = this.sessionsState.state[sessionId];
      if (session?.type !== "worktree-setup") {
        return;
      }

      const commands = session.steps.map((s) => s.command);
      const stepCount = commands.length;

      for (let i = 0; i < stepCount; i++) {
        if (signal.aborted) {
          patchStep(i, {
            status: "error",
            errorMessage: "Cancelled.",
          });
          setSessionDone("stopped");
          return;
        }

        patchStep(i, {
          status: "running",
          output: "",
          errorMessage: undefined,
          outputTruncated: false,
        });

        const command = commands[i];

        let output = "";
        let truncated = false;

        const syncDebounced = withDebouncedRunner(() => {
          patchStep(i, {
            output,
            outputTruncated: truncated,
          });
        }, 75);

        try {
          const subprocess = spawn(command, {
            shell: true,
            cwd: worktreeRoot,
            env,
            signal,
          });

          for await (const line of subprocess) {
            if (signal.aborted) {
              const err = new Error("Aborted");
              err.name = "AbortError";
              throw err;
            }
            if (!truncated) {
              const appended = appendOutputLine(output, line);
              output = appended.text;
              truncated = appended.truncated;
              syncDebounced.schedule();
            }
          }

          syncDebounced.dispose();

          patchStep(i, {
            status: "success",
            output,
            outputTruncated: truncated,
          });
        } catch (error) {
          syncDebounced.dispose();

          const message =
            error instanceof Error ? error.message : String(error);
          const isAbort =
            signal.aborted ||
            (error instanceof Error && error.name === "AbortError");

          if (isAbort) {
            patchStep(i, {
              status: "error",
              output,
              errorMessage: "Cancelled.",
              outputTruncated: truncated,
            });
            setSessionDone("stopped");
            return;
          }

          log.warn("Worktree setup command failed", {
            command,
            cwd: worktreeRoot,
            error: message,
          });

          let errOut = "";
          if (error && typeof error === "object" && "output" in error) {
            const o = (error as { output?: string }).output;
            if (typeof o === "string" && o) {
              errOut = truncateToMax(o, WORKTREE_SETUP_MAX_OUTPUT_CHARS).text;
            }
          }

          const errMsg = truncateToMax(
            message,
            WORKTREE_SETUP_MAX_OUTPUT_CHARS,
          );

          patchStep(i, {
            status: "error",
            output: errOut || output,
            errorMessage: errMsg.text,
            outputTruncated: errMsg.truncated || truncated,
          });

          setSessionDone("error");
          return;
        }
      }

      setSessionDone("awaiting_user_response");
    } catch (error) {
      log.error("Worktree setup session failed", error);
      setSessionDone("error");
    }
  }
}
