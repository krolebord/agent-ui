import { claudeHookEventSchema } from "../shared/claude-schemas";
import type {
  ClaudeActivityState,
  ClaudeHookEvent,
} from "../shared/claude-types";
import log from "./logger";
import { NdjsonFileWatcher } from "./ndjson-file-watcher";

const POLL_INTERVAL_MS = 180;
const POLL_CHECK_MIN_ELAPSED_MS = 250;

interface ActivityMonitorEvents {
  onStatusChange: (status: ClaudeActivityState) => void;
  onHookEvent: (event: ClaudeHookEvent) => void;
}

export class ClaudeActivityMonitor {
  private readonly callbacks: ActivityMonitorEvents;
  private state: ClaudeActivityState = "unknown";
  private watcher: NdjsonFileWatcher<ClaudeHookEvent> | null = null;
  private watcherGeneration = 0;

  constructor(callbacks: ActivityMonitorEvents) {
    this.callbacks = callbacks;
  }

  getState(): ClaudeActivityState {
    return this.state;
  }

  startMonitoring(stateFilePath: string): void {
    this.stopMonitoring({ preserveState: false });
    const generation = this.watcherGeneration;

    const watcher = new NdjsonFileWatcher<ClaudeHookEvent>({
      filePath: stateFilePath,
      schema: claudeHookEventSchema,
      pollIntervalMs: POLL_INTERVAL_MS,
      pollStaleCheckMs: POLL_CHECK_MIN_ELAPSED_MS,
      startFromBeginning: true,
      onData: (event) => {
        if (this.watcher !== watcher || this.watcherGeneration !== generation) {
          return;
        }

        this.callbacks.onHookEvent(event);
        this.setState(this.reduceState(event));
      },
      onError: (error) => {
        if (this.watcher !== watcher || this.watcherGeneration !== generation) {
          return;
        }

        log.error("Claude state watcher error:", error);
      },
    });

    this.watcher = watcher;

    void watcher.start().catch((error) => {
      if (this.watcher !== watcher || this.watcherGeneration !== generation) {
        return;
      }

      log.error("Failed to start Claude state watcher:", error);
    });
  }

  stopMonitoring(options?: { preserveState?: boolean }): void {
    this.watcherGeneration += 1;

    const watcher = this.watcher;
    this.watcher = null;

    if (watcher) {
      void watcher.stop().catch((error) => {
        log.error("Failed to stop Claude state watcher:", error);
      });
    }

    if (!options?.preserveState) {
      this.setState("unknown");
    }
  }

  private reduceState(event: ClaudeHookEvent): ClaudeActivityState {
    switch (event.hook_event_name) {
      case "SessionStart":
      case "SessionEnd": {
        return "idle";
      }
      case "Stop": {
        return "awaiting_user_response";
      }
      case "UserPromptSubmit":
      case "PreToolUse":
      case "PostToolUse":
      case "PostToolUseFailure": {
        return "working";
      }
      case "PermissionRequest": {
        return "awaiting_approval";
      }
      case "Notification": {
        if (
          event.notification_type === "permission_prompt" ||
          event.notification_type === "permission_request"
        ) {
          return "awaiting_approval";
        }

        if (
          event.notification_type === "idle_prompt" ||
          event.notification_type === "idle"
        ) {
          return "awaiting_user_response";
        }

        return this.state;
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
