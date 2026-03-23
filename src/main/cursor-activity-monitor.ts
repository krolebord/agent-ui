import type { ClaudeActivityState } from "../shared/claude-types";
import {
  type CursorHookEvent,
  cursorHookEventSchema,
} from "../shared/cursor-hooks";
import log from "./logger";
import { NdjsonFileWatcher } from "./ndjson-file-watcher";

const POLL_INTERVAL_MS = 180;
const POLL_CHECK_MIN_ELAPSED_MS = 250;

interface CursorActivityMonitorEvents {
  onStatusChange: (status: ClaudeActivityState) => void;
  onHookEvent?: (event: CursorHookEvent) => void;
}

export class CursorActivityMonitor {
  private readonly callbacks: CursorActivityMonitorEvents;
  private state: ClaudeActivityState = "unknown";
  private watcher: NdjsonFileWatcher<CursorHookEvent> | null = null;
  private watcherGeneration = 0;

  constructor(callbacks: CursorActivityMonitorEvents) {
    this.callbacks = callbacks;
  }

  getState(): ClaudeActivityState {
    return this.state;
  }

  async startMonitoring(input: { stateFilePath: string }): Promise<void> {
    this.stopMonitoring({ preserveState: false });
    const generation = this.watcherGeneration;

    const watcher = new NdjsonFileWatcher<CursorHookEvent>({
      filePath: input.stateFilePath,
      schema: cursorHookEventSchema,
      pollIntervalMs: POLL_INTERVAL_MS,
      pollStaleCheckMs: POLL_CHECK_MIN_ELAPSED_MS,
      startFromBeginning: false,
      onData: (event) => {
        if (this.watcher !== watcher || this.watcherGeneration !== generation) {
          return;
        }

        this.callbacks.onHookEvent?.(event);
        this.setState(this.reduceState(event));
      },
      onError: (error) => {
        if (this.watcher !== watcher || this.watcherGeneration !== generation) {
          return;
        }

        log.error("Cursor hook watcher error:", error);
      },
    });

    this.watcher = watcher;
    try {
      await watcher.start();
    } catch (error) {
      if (this.watcher !== watcher || this.watcherGeneration !== generation) {
        return;
      }

      log.error("Failed to start Cursor hook watcher:", error);
    }
  }

  stopMonitoring(options?: { preserveState?: boolean }): void {
    this.watcherGeneration += 1;

    const watcher = this.watcher;
    this.watcher = null;

    if (watcher) {
      void watcher.stop().catch((error) => {
        log.error("Failed to stop Cursor hook watcher:", error);
      });
    }

    if (!options?.preserveState) {
      this.setState("unknown");
    }
  }

  private reduceState(event: CursorHookEvent): ClaudeActivityState {
    if (event.permission === "ask") {
      return "awaiting_approval";
    }

    switch (event.hook_event_name) {
      case "sessionStart":
      case "sessionEnd": {
        return "idle";
      }
      case "stop": {
        if (event.status === "completed") {
          return "awaiting_user_response";
        }
        return "idle";
      }
      case "preToolUse":
      case "postToolUse":
      case "postToolUseFailure":
      case "afterShellExecution":
      case "afterMCPExecution":
      case "afterFileEdit":
      case "beforeSubmitPrompt":
      case "afterAgentThought": {
        return "working";
      }
      case "beforeShellExecution":
      case "beforeMCPExecution":
      case "beforeReadFile": {
        return "awaiting_approval";
      }
      case "afterAgentResponse": {
        return "awaiting_user_response";
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
