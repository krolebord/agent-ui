import path from "node:path";
import {
  concatAndTruncate,
  createDeferredPromise,
  createDisposable,
} from "@shared/utils";
import { type IPty, spawn } from "node-pty";
import log from "./logger";

export type TerminalSessionStatus =
  | "starting"
  | "stopping"
  | "running"
  | "stopped"
  | "error";

export type TerminalExitPayload = {
  exitCode: number | null;
  signal?: number;
  errorMessage?: string;
  /**
   * True when this exit is the result of `stop()` (settle, Stop button, etc.).
   * False when the process died on its own. Callers use this to decide whether
   * the exit counts as fresh activity for inbox settle/snooze.
   */
  stoppedByUser: boolean;
};

type TerminalSessionOpts = {
  onStatusChange: (status: TerminalSessionStatus) => void;
  onData: (payload: { chunk: string; bufferedOutput: string }) => void;
  onExit: (payload: TerminalExitPayload) => Promise<void> | void;
};

type TerminalStartOpts = {
  cols?: number;
  rows?: number;
  cwd: string;
  env?: Record<string, string>;
} & (
  | {
      runWithShell: true;
      file?: string;
      args?: string[];
    }
  | {
      runWithShell?: false;
      file: string;
      args: string[];
    }
);

type LaunchCommand = {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

function resolveLaunchCommand(launch: TerminalStartOpts): LaunchCommand {
  if (launch.runWithShell) {
    const shell =
      process.env.SHELL ??
      (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
    const bashRcFile = launch.env?.AGENT_UI_BASH_RCFILE;
    const bashArgs =
      path.basename(shell) === "bash" && bashRcFile
        ? ["--rcfile", bashRcFile]
        : [];
    if (launch.file) {
      const command = ["exec", launch.file, ...(launch.args ?? [])].join(" ");
      return {
        file: shell,
        args:
          bashArgs.length > 0
            ? [...bashArgs, "-ic", command]
            : ["-ilc", command],
        cwd: launch.cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          ...(launch.env ?? {}),
        },
      };
    }
    return {
      file: shell,
      args: bashArgs.length > 0 ? [...bashArgs, "-i"] : ["-il"],
      cwd: launch.cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        ...(launch.env ?? {}),
      },
    };
  }

  return {
    file: launch.file,
    args: launch.args,
    cwd: launch.cwd,
    env: launch.env ?? {},
  };
}

export const TERMINAL_STOP_TIMEOUTS = {
  sighup: 1500,
  sigterm: 1500,
  sigkill: 2000,
} as const;
const OUTPUT_BUFFER_MAX_TOTAL_SIZE = 512 * 1024;

export function createTerminalSession(events: TerminalSessionOpts) {
  const disposable = createDisposable({
    onError: (error) => {
      log.error("Error disposing of terminal session", error);
    },
  });

  let sessionStatus: TerminalSessionStatus = "stopped";
  let stopping = false;
  let stopPromise: Promise<void> | null = null;
  let finalizationPromise: Promise<void> | null = null;

  let pty: IPty | null = null;
  const exitCompletion = createDeferredPromise<void>();

  let bufferedOutput = "";

  const changeSessionStatus = (status: TerminalSessionStatus) => {
    sessionStatus = status;
    events.onStatusChange(status);
  };

  const finalizeExit = ({
    status,
    exitCode,
    signal,
    errorMessage,
  }: {
    status: TerminalSessionStatus;
    exitCode: number | null;
    signal?: number;
    errorMessage?: string;
  }): Promise<void> => {
    if (finalizationPromise) {
      return finalizationPromise;
    }

    const stoppedByUser = stopping;
    finalizationPromise = (async () => {
      // Stop accepting input as soon as the authoritative PTY exit arrives.
      pty = null;
      await disposable.dispose();
      changeSessionStatus(status);
      try {
        await events.onExit({
          exitCode,
          signal,
          errorMessage,
          stoppedByUser,
        });
      } catch (error) {
        log.error("Error handling terminal exit", error);
      } finally {
        // `stop()` resolves only after downstream snapshot/map cleanup finishes.
        exitCompletion.resolve(undefined);
      }
    })();

    return finalizationPromise;
  };

  const start = (opts: TerminalStartOpts) => {
    if (pty) {
      return;
    }

    changeSessionStatus("starting");

    const safeCols =
      opts.cols != null && Number.isFinite(opts.cols) && opts.cols > 0
        ? Math.floor(opts.cols)
        : 80;
    const safeRows =
      opts.rows != null && Number.isFinite(opts.rows) && opts.rows > 0
        ? Math.floor(opts.rows)
        : 24;
    const launchCommand = resolveLaunchCommand(opts);

    try {
      log.info("PTY spawn", {
        file: launchCommand.file,
        args: launchCommand.args,
        cwd: launchCommand.cwd,
      });
      pty = spawn(launchCommand.file, launchCommand.args, {
        name: "xterm-256color",
        cols: safeCols,
        rows: safeRows,
        cwd: launchCommand.cwd,
        env: launchCommand.env,
      });

      let receivedFirstData = false;
      const onData = pty.onData((chunk) => {
        if (disposable.isDisposed) {
          return;
        }
        if (!receivedFirstData) {
          receivedFirstData = true;
          changeSessionStatus("running");
        }
        bufferedOutput = concatAndTruncate({
          base: bufferedOutput ?? "",
          chunk,
          maxTotalSize: OUTPUT_BUFFER_MAX_TOTAL_SIZE,
        });
        events.onData({
          chunk,
          bufferedOutput,
        });
      });
      disposable.addDisposable(() => onData.dispose());

      const onExit = pty.onExit(({ exitCode, signal }) => {
        if (disposable.isDisposed) {
          return;
        }

        if (exitCode === 127) {
          const message = `\`${launchCommand.file}\` was not found in PATH for the interactive shell session.`;
          log.error(
            `PTY exit: ${launchCommand.file} not found (exit code 127)`,
          );
          void finalizeExit({
            status: "error",
            exitCode: null,
            signal: undefined,
            errorMessage: message,
          });
        } else {
          void finalizeExit({
            status: "stopped",
            exitCode,
            signal: signal ?? undefined,
          });
        }
      });
      disposable.addDisposable(() => onExit.dispose());
    } catch (error) {
      const message = getStartErrorMessage(error, launchCommand.file);

      void finalizeExit({
        status: "error",
        exitCode: null,
        signal: undefined,
        errorMessage: message,
      });
      log.error("PTY spawn failed", { message, error });
    }
  };

  const waitForExit = (timeoutMs: number): Promise<boolean> => {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), timeoutMs);
      timeout.unref?.();
      void exitCompletion.promise.then(
        () => {
          clearTimeout(timeout);
          resolve(true);
        },
        () => {
          clearTimeout(timeout);
          resolve(true);
        },
      );
    });
  };

  const stop = (): Promise<void> => {
    if (stopPromise) {
      return stopPromise;
    }
    if (finalizationPromise) {
      return finalizationPromise;
    }
    if (!pty) {
      return Promise.resolve();
    }

    stopping = true;
    changeSessionStatus("stopping");
    const activePty = pty;

    stopPromise = (async () => {
      const stages: ReadonlyArray<{
        signal: NodeJS.Signals;
        timeoutMs: number;
      }> = [
        { signal: "SIGHUP", timeoutMs: TERMINAL_STOP_TIMEOUTS.sighup },
        { signal: "SIGTERM", timeoutMs: TERMINAL_STOP_TIMEOUTS.sigterm },
        { signal: "SIGKILL", timeoutMs: TERMINAL_STOP_TIMEOUTS.sigkill },
      ];

      for (const stage of stages) {
        try {
          activePty.kill(stage.signal);
        } catch (error) {
          log.warn("Failed to signal terminal PTY", {
            signal: stage.signal,
            error,
          });
        }
        if (await waitForExit(stage.timeoutMs)) {
          return;
        }
      }

      await finalizeExit({
        status: "error",
        exitCode: null,
        signal: undefined,
        errorMessage: "Failed to stop terminal session.",
      });
    })();

    return stopPromise;
  };

  const write = (data: string): void => {
    if (disposable.isDisposed || !pty) {
      return;
    }

    pty.write(data);
  };

  const resize = (cols: number, rows: number): void => {
    if (disposable.isDisposed || !pty) {
      return;
    }

    const safeCols = Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : 80;
    const safeRows = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 24;

    pty.resize(safeCols, safeRows);
  };

  const clear = (): void => {
    if (disposable.isDisposed || !pty) {
      return;
    }

    pty.clear();
  };

  return {
    start,
    stop,
    write,
    resize,
    clear,
    get status() {
      return sessionStatus;
    },
    get bufferedOutput() {
      return bufferedOutput;
    },
  };
}

export type TerminalSession = ReturnType<typeof createTerminalSession>;

function getStartErrorMessage(error: unknown, execName: string): string {
  if (error instanceof Error) {
    if (error.message.includes("ENOENT")) {
      return `\`${execName}\` was not found in PATH. Install it or add it to PATH.`;
    }
    return `Failed to start ${execName}: ${error.message}`;
  }

  return `Failed to start ${execName} due to an unknown error.`;
}
