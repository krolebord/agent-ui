import type { ClaudeHookEvent } from "../../shared/claude-types";
import { ClaudeActivityMonitor } from "../claude-activity-monitor";
import { withDebouncedRunner } from "../debounce-runner";
import {
  createTerminalSession,
  type TerminalSession,
} from "../terminal-session";
import type { SessionStatus } from "./common";

export interface CreateClaudeProcessInput {
  stateFilePath: string;
  cwd: string;
  cols?: number;
  rows?: number;
  claudeArgs: { args: string[]; env: Record<string, string> };
  syncDebounceMs?: number;
  stoppedMeansIdle?: boolean;
}

export interface CreateClaudeProcessCallbacks {
  onSessionStatusChange: (status: SessionStatus) => void;
  onBufferedOutputSync: (bufferedOutput: string) => void;
  onTerminalData: (chunk: string) => void;
  onTerminalExit: (payload: {
    exitCode: number | null;
    signal?: number;
    errorMessage?: string;
  }) => void;
  onHookEvent: (event: ClaudeHookEvent) => void;
}

export interface ClaudeProcessHandle {
  terminal: TerminalSession;
  activityMonitor: ClaudeActivityMonitor;
  syncBufferedOutput: ReturnType<typeof withDebouncedRunner>;
  start: () => void;
}

function getSessionStatus(
  terminal: TerminalSession,
  activityMonitor: ClaudeActivityMonitor,
  opts?: { stoppedMeansIdle?: boolean },
): SessionStatus {
  const terminalStatus = terminal.status;
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

/**
 * Creates a Claude CLI process with terminal, activity monitor, and buffered
 * output sync wired together. Call `handle.start()` after registering the
 * session in your live sessions map to avoid race conditions with early events.
 */
export function createClaudeProcess(
  input: CreateClaudeProcessInput,
  callbacks: CreateClaudeProcessCallbacks,
): ClaudeProcessHandle {
  const syncBufferedOutput = withDebouncedRunner(() => {
    callbacks.onBufferedOutputSync(terminal.bufferedOutput);
  }, input.syncDebounceMs ?? 500);

  const activityMonitor = new ClaudeActivityMonitor({
    onStatusChange: (activityStatus) => {
      callbacks.onSessionStatusChange(
        getSessionStatus(terminal, activityMonitor, {
          stoppedMeansIdle: input.stoppedMeansIdle,
        }),
      );
      if (
        activityStatus === "idle" ||
        activityStatus === "awaiting_approval" ||
        activityStatus === "awaiting_user_response"
      ) {
        syncBufferedOutput.flush();
      }
    },
    onHookEvent: callbacks.onHookEvent,
  });

  const terminal = createTerminalSession({
    onData: ({ chunk }) => {
      callbacks.onTerminalData(chunk);
      syncBufferedOutput.schedule();
    },
    onStatusChange: (terminalStatus) => {
      callbacks.onSessionStatusChange(
        getSessionStatus(terminal, activityMonitor, {
          stoppedMeansIdle: input.stoppedMeansIdle,
        }),
      );
      if (terminalStatus === "stopped") {
        syncBufferedOutput.flush();
      }
    },
    onExit: callbacks.onTerminalExit,
  });

  return {
    terminal,
    activityMonitor,
    syncBufferedOutput,
    start: () => {
      activityMonitor.startMonitoring(input.stateFilePath);
      terminal.start({
        cwd: input.cwd,
        runWithShell: true,
        file: "claude",
        args: input.claudeArgs.args,
        env: input.claudeArgs.env,
        cols: input.cols,
        rows: input.rows,
      });
    },
  };
}
