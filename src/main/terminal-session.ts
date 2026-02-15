import { StringRingBuffer } from "@shared/string-ring-buffer";
import { type DeferredPromise, createDeferredPromise } from "@shared/utils";
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
  onData: (chunk: string) => void;
  onExit: (payload: {
    exitCode: number | null;
    signal?: number;
    errorMessage?: string;
  }) => void;
};

type TerminalStartOpts = {
  cols?: number;
  rows?: number;
  file: string;
  args: string[];
  cwd: string;
  runWithShell?: boolean;
  env?: Record<string, string>;
};

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
    const command = ["exec", launch.file, ...launch.args].join(" ");
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
    file: launch.file,
    args: launch.args,
    cwd: launch.cwd,
    env: launch.env ?? {},
  };
}

const GRACEFUL_STOP_TIMEOUT_MS = 1000;
const FORCE_KILL_TIMEOUT_MS = 5000;
const OUTPUT_BUFFER_MAX_TOTAL_SIZE = 2 * 1024 * 1024;

export function createTerminalSession(events: TerminalSessionOpts) {
  let disposed = false;
  let stopping = false;
  const disposables = [] as Array<() => void>;

  let pty: IPty | null = null;

  const exitPromises = new Set<DeferredPromise<boolean>>();
  disposables.push(() => exitPromises.clear());

  const outputBuffer = new StringRingBuffer({
    maxTotalSize: OUTPUT_BUFFER_MAX_TOTAL_SIZE,
  });

  const dispose = ({
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
    if (disposed) {
      return;
    }

    disposed = true;
    for (const dispose of disposables) {
      dispose();
    }

    events.onStatusChange(status);
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

    events.onStatusChange("starting");

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
        if (disposed) {
          return;
        }
        if (!receivedFirstData) {
          receivedFirstData = true;
          events.onStatusChange("running");
        }
        outputBuffer.push(chunk);
        events.onData(chunk);
      });
      disposables.push(() => onData.dispose());

      const onExit = pty.onExit(({ exitCode, signal }) => {
        if (disposed) {
          return;
        }

        if (exitCode === 127) {
          const message =
            "`claude` was not found in PATH for the interactive shell session.";
          log.error("PTY exit: claude not found (exit code 127)");
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
      disposables.push(() => onExit.dispose());
    } catch (error) {
      const message = getStartErrorMessage(error);

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
    disposables.push(() => promise.resolve(true));
    return await promise.promise.catch(() => false);
  };

  const stop = async () => {
    if (disposed || !pty || stopping) {
      return;
    }
    stopping = true;
    events.onStatusChange("stopping");

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
    if (disposed || !pty) {
      return;
    }

    pty.write(data);
  };

  const resize = (cols: number, rows: number): void => {
    if (disposed || !pty) {
      return;
    }

    const safeCols = Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : 80;
    const safeRows = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 24;

    pty.resize(safeCols, safeRows);
  };

  const clear = (): void => {
    if (disposed || !pty) {
      return;
    }

    outputBuffer.clear();
    pty.clear();
  };

  return {
    start,
    stop,
    write,
    resize,
    clear,
    getOutputBuffer: () => outputBuffer.getFullContent(),
  };
}

export type TerminalSession = ReturnType<typeof createTerminalSession>;

function getStartErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.includes("ENOENT")) {
      return "`claude` was not found in PATH. Install Claude CLI or add it to PATH.";
    }
    return `Failed to start Claude: ${error.message}`;
  }

  return "Failed to start Claude due to an unknown error.";
}
