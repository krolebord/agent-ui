import { type FSWatcher, watch } from "node:fs";
import { open, stat } from "node:fs/promises";
import { claudeHookEventSchema } from "../shared/claude-schemas";
import type {
  ClaudeActivityState,
  ClaudeHookEvent,
} from "../shared/claude-types";
import log from "./logger";

const POLL_INTERVAL_MS = 180;
const POLL_CHECK_MIN_ELAPSED_MS = 250;

interface ActivityMonitorEvents {
  onStatusChange: (status: ClaudeActivityState) => void;
  onHookEvent: (event: ClaudeHookEvent) => void;
}

export class ClaudeActivityMonitor {
  private readonly callbacks: ActivityMonitorEvents;
  private state: ClaudeActivityState = "unknown";
  private stateFilePath: string | null = null;
  private fileOffset = 0;
  private buffer = "";
  private watcher: FSWatcher | null = null;
  private pollingIntervalId: NodeJS.Timeout | null = null;
  private isPolling = false;
  private pollRequested = false;
  private lastPollingCheckAt = 0;
  private usingPollingFallback = false;

  constructor(callbacks: ActivityMonitorEvents) {
    this.callbacks = callbacks;
  }

  getState(): ClaudeActivityState {
    return this.state;
  }

  startMonitoring(stateFilePath: string): void {
    this.stopMonitoring({ preserveState: false });

    this.stateFilePath = stateFilePath;
    this.fileOffset = 0;
    this.buffer = "";
    this.setState("unknown");
    this.startPollingInterval();

    try {
      this.startWatcher(stateFilePath);
    } catch (e) {
      log.error("Failed to start file watcher:", e);
      this.usingPollingFallback = true;
    }

    void this.requestPoll();
  }

  stopMonitoring(options?: { preserveState?: boolean }): void {
    this.stopWatcher();

    this.stateFilePath = null;
    this.fileOffset = 0;
    this.buffer = "";
    this.isPolling = false;
    this.pollRequested = false;
    this.lastPollingCheckAt = 0;
    this.usingPollingFallback = false;

    if (!options?.preserveState) {
      this.setState("unknown");
    }
  }

  private startPollingInterval(): void {
    if (this.pollingIntervalId) {
      return;
    }

    this.pollingIntervalId = setInterval(() => {
      const now = Date.now();
      const isPollingCheckStale =
        now - this.lastPollingCheckAt > POLL_CHECK_MIN_ELAPSED_MS;
      if (isPollingCheckStale || this.usingPollingFallback) {
        void this.requestPoll();
      }
    }, POLL_INTERVAL_MS);
  }

  private startWatcher(stateFilePath: string): void {
    try {
      this.watcher = watch(stateFilePath, () => {
        void this.requestPoll();
      });

      this.watcher.on("error", (e) => {
        log.error("File watcher error:", e);
        this.usingPollingFallback = true;
      });
    } catch (e) {
      log.error("Failed to start file watcher:", e);
      this.usingPollingFallback = true;
    }
  }

  private stopWatcher(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (this.pollingIntervalId) {
      clearInterval(this.pollingIntervalId);
      this.pollingIntervalId = null;
    }
  }

  private async requestPoll(): Promise<void> {
    this.pollRequested = true;

    if (this.isPolling || !this.stateFilePath) {
      return;
    }

    this.isPolling = true;

    try {
      while (this.pollRequested && this.stateFilePath) {
        this.pollRequested = false;
        await this.pollOnce();
      }
    } finally {
      this.isPolling = false;
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.stateFilePath) {
      return;
    }

    this.lastPollingCheckAt = Date.now();

    const stateFilePath = this.stateFilePath;

    const fileStats = await stat(stateFilePath).catch(() => null);
    if (!fileStats) {
      return;
    }

    if (fileStats.size < this.fileOffset) {
      this.fileOffset = 0;
      this.buffer = "";
    }

    if (fileStats.size === this.fileOffset) {
      return;
    }

    const bytesToRead = Number(fileStats.size - this.fileOffset);
    const handle = await open(stateFilePath, "r");

    try {
      const chunkBuffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(
        chunkBuffer,
        0,
        bytesToRead,
        this.fileOffset,
      );

      if (!bytesRead) {
        return;
      }

      this.fileOffset += bytesRead;
      this.processChunk(chunkBuffer.toString("utf8", 0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  private processChunk(chunk: string): void {
    this.buffer += chunk;

    while (true) {
      const newLineIndex = this.buffer.indexOf("\n");
      if (newLineIndex < 0) {
        break;
      }

      const line = this.buffer.slice(0, newLineIndex).trim();
      this.buffer = this.buffer.slice(newLineIndex + 1);

      if (!line) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const result = claudeHookEventSchema.safeParse(parsed);
      if (!result.success) {
        continue;
      }

      const event: ClaudeHookEvent = result.data;
      this.callbacks.onHookEvent(event);
      this.setState(this.reduceState(event));
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
