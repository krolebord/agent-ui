import {
  concatAndTruncate,
  createDeferredPromise,
  createDisposable,
  type DeferredPromise,
} from "@shared/utils";
import { type IPty, spawn } from "node-pty";
import log from "./logger";

export type TerminalSessionStatus =
  | "starting"
  | "stopping"
  | "running"
  | "stopped"
  | "error";

type TerminalSessionOpts = {
  onStatusChange: (status: TerminalSessionStatus) => void;
  onData: (payload: { chunk: string; bufferedOutput: string }) => void;
  onExit: (payload: {
    exitCode: number | null;
    signal?: number;
    errorMessage?: string;
  }) => void;
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
    if (launch.file) {
      const command = ["exec", launch.file, ...(launch.args ?? [])].join(" ");
      return {
        file: shell,
        args: ["-ilc", command],
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
      args: ["-il"],
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

const GRACEFUL_STOP_TIMEOUT_MS = 1000;
const FORCE_KILL_TIMEOUT_MS = 5000;
const OUTPUT_BUFFER_MAX_TOTAL_SIZE = 1024 * 1024;

export function createTerminalSession(events: TerminalSessionOpts) {
  const disposable = createDisposable({
    onError: (error) => {
      log.error("Error disposing of terminal session", error);
    },
  });

  let sessionStatus: TerminalSessionStatus = "stopped";
  let stopping = false;

  let pty: IPty | null = null;

  const exitPromises = new Set<DeferredPromise<boolean>>();
  disposable.addDisposable(() => exitPromises.clear());

  let bufferedOutput = "";

  const changeSessionStatus = (status: TerminalSessionStatus) => {
    sessionStatus = status;
    events.onStatusChange(status);
  };

  const dispose = async ({
    status,
    exitCode,
    signal,
    errorMessage,
  }: {
    status: TerminalSessionStatus;
    exitCode: number | null;
    signal?: number;
    errorMessage?: string;
  }) => {
    if (disposable.isDisposed) {
      return;
    }

    await disposable.dispose();
    changeSessionStatus(status);
    events.onExit({
      exitCode,
      signal,
      errorMessage,
    });
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
          dispose({
            status: "error",
            exitCode: null,
            signal: undefined,
            errorMessage: message,
          });
        } else {
          dispose({
            status: "stopped",
            exitCode,
            signal: signal ?? undefined,
          });
        }
      });
      disposable.addDisposable(() => onExit.dispose());
    } catch (error) {
      const message = getStartErrorMessage(error, launchCommand.file);

      dispose({
        status: "error",
        exitCode: null,
        signal: undefined,
        errorMessage: message,
      });
      log.error("PTY spawn failed", { message, error });
    }
  };

  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    const promise = createDeferredPromise<boolean>({ timeout: timeoutMs });
    exitPromises.add(promise);
    disposable.addDisposable(() => promise.resolve(true));
    return await promise.promise.catch(() => false);
  };

  const stop = async () => {
    if (disposable.isDisposed || !pty || stopping) {
      return;
    }
    stopping = true;
    changeSessionStatus("stopping");

    pty.kill("SIGTERM");
    if (await waitForExit(GRACEFUL_STOP_TIMEOUT_MS)) {
      return;
    }

    pty.kill("SIGKILL");
    if (await waitForExit(FORCE_KILL_TIMEOUT_MS)) {
      return;
    }

    dispose({
      status: "error",
      exitCode: null,
      signal: undefined,
      errorMessage: "Failed to stop terminal session.",
    });
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
