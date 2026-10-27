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
  private mainAgentState: ClaudeActivityState = "unknown";
  private readonly runningSubagentIds = new Set<string>();
  private readonly subagentIdsAwaitingApproval = new Set<string>();
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
        this.trackSubagents(event);
        if (!event.agent_id) {
          this.mainAgentState = this.reduceState(event);
        }
        this.setState(this.deriveState());
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

    this.runningSubagentIds.clear();
    this.subagentIdsAwaitingApproval.clear();

    if (!options?.preserveState) {
      this.mainAgentState = "unknown";
      this.setState("unknown");
    }
  }

  private trackSubagents(event: ClaudeHookEvent): void {
    switch (event.hook_event_name) {
      case "SubagentStart": {
        if (event.agent_id) {
          this.runningSubagentIds.add(event.agent_id);
        }
        return;
      }
      case "SubagentStop": {
        if (event.agent_id) {
          this.runningSubagentIds.delete(event.agent_id);
          this.subagentIdsAwaitingApproval.delete(event.agent_id);
        }
        return;
      }
      case "PreToolUse": {
        if (event.agent_id) {
          this.subagentIdsAwaitingApproval.delete(event.agent_id);
        }
        return;
      }
      case "PermissionRequest": {
        if (event.agent_id) {
          this.subagentIdsAwaitingApproval.add(event.agent_id);
        }
        return;
      }
      case "Stop": {
        if (!event.background_tasks) {
          return;
        }
        this.runningSubagentIds.clear();
        for (const task of event.background_tasks) {
          if (task.type === "subagent" && task.id) {
            this.runningSubagentIds.add(task.id);
          }
        }
        for (const agentId of this.subagentIdsAwaitingApproval) {
          if (!this.runningSubagentIds.has(agentId)) {
            this.subagentIdsAwaitingApproval.delete(agentId);
          }
        }
        return;
      }
    }
  }

  private deriveState(): ClaudeActivityState {
    if (this.subagentIdsAwaitingApproval.size > 0) {
      return "awaiting_approval";
    }

    if (
      this.runningSubagentIds.size > 0 &&
      (this.mainAgentState === "idle" ||
        this.mainAgentState === "awaiting_user_response")
    ) {
      return "working";
    }

    return this.mainAgentState;
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
      case "PreToolUse": {
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
          // Notifications carry no agent_id, so with subagents running this
          // may belong to one of them; their PermissionRequest covers it.
          return this.runningSubagentIds.size > 0
            ? this.mainAgentState
            : "awaiting_approval";
        }

        if (
          event.notification_type === "idle_prompt" ||
          event.notification_type === "idle"
        ) {
          return "awaiting_user_response";
        }

        return this.mainAgentState;
      }
      default: {
        return this.mainAgentState;
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
