import type { ClaudeActivityState } from "../shared/claude-types";
import {
  type CodexLogEvent,
  codexLogEventSchema,
} from "../shared/codex-log-events";
import log from "./logger";
import { NdjsonFileWatcher } from "./ndjson-file-watcher";

const POLL_INTERVAL_MS = 180;
const POLL_CHECK_MIN_ELAPSED_MS = 250;

interface CodexActivityMonitorEvents {
  onStatusChange: (status: ClaudeActivityState) => void;
  onLogEvent?: (event: CodexLogEvent) => void;
}

export class CodexActivityMonitor {
  private readonly callbacks: CodexActivityMonitorEvents;
  private state: ClaudeActivityState = "unknown";
  private watcher: NdjsonFileWatcher<CodexLogEvent> | null = null;
  private watcherGeneration = 0;

  constructor(callbacks: CodexActivityMonitorEvents) {
    this.callbacks = callbacks;
  }

  getState(): ClaudeActivityState {
    return this.state;
  }

  startMonitoring(logFilePath: string): void {
    this.stopMonitoring({ preserveState: false });
    const generation = this.watcherGeneration;

    const watcher = new NdjsonFileWatcher<CodexLogEvent>({
      filePath: logFilePath,
      schema: codexLogEventSchema,
      pollIntervalMs: POLL_INTERVAL_MS,
      pollStaleCheckMs: POLL_CHECK_MIN_ELAPSED_MS,
      startFromBeginning: true,
      onData: (event) => {
        if (this.watcher !== watcher || this.watcherGeneration !== generation) {
          return;
        }

        this.callbacks.onLogEvent?.(event);
        this.setState(this.reduceState(event));
      },
      onError: (error) => {
        if (this.watcher !== watcher || this.watcherGeneration !== generation) {
          return;
        }

        log.error("Codex session log watcher error:", error);
      },
    });

    this.watcher = watcher;

    void watcher.start().catch((error) => {
      if (this.watcher !== watcher || this.watcherGeneration !== generation) {
        return;
      }

      log.error("Failed to start Codex session log watcher:", error);
    });
  }

  stopMonitoring(options?: { preserveState?: boolean }): void {
    this.watcherGeneration += 1;

    const watcher = this.watcher;
    this.watcher = null;

    if (watcher) {
      void watcher.stop().catch((error) => {
        log.error("Failed to stop Codex session log watcher:", error);
      });
    }

    if (!options?.preserveState) {
      this.setState("unknown");
    }
  }

  private reduceState(event: CodexLogEvent): ClaudeActivityState {
    if (event.kind !== "codex_event") {
      return this.state;
    }

    switch (event.payload?.msg?.type) {
      case "session_configured":
        return "idle";
      case "task_complete":
      case "turn_aborted": {
        return "awaiting_user_response";
      }
      case "task_started": {
        return "working";
      }
      case "request_user_input": {
        return "awaiting_approval";
      }
      default: {
        return this.state;
      }
    }
  }

  private setState(nextState: ClaudeActivityState): void {
    if (this.state === nextState) {
      return;
    }

    this.state = nextState;
    this.callbacks.onStatusChange(nextState);
  }
}
