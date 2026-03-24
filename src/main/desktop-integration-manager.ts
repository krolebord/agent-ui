import { app, BrowserWindow, powerSaveBlocker } from "electron";
import type { AppSettingsState } from "./app-settings";
import log from "./logger";
import type { SessionStatus } from "./sessions/common";
import type { SessionServiceState } from "./sessions/state";

const BLOCKER_TYPE = "prevent-display-sleep";

const ATTENTION_STATUSES = new Set<SessionStatus>([
  "awaiting_user_response",
  "awaiting_approval",
]);

const DOCK_BOUNCE_DELAY_MS = 2000;

export class DesktopIntegrationManager {
  private blockerId: number | null = null;
  private isDisposed = false;
  private sessionStatusSnapshot: Map<string, SessionStatus> | null = null;
  private pendingDockBounces = new Map<
    string,
    { timeoutId: ReturnType<typeof setTimeout>; expectedStatus: SessionStatus }
  >();

  constructor(
    private readonly sessionsState: SessionServiceState,
    private readonly appSettingsState: AppSettingsState,
  ) {
    this.sessionsState.eventTarget.addEventListener(
      "state-update",
      this.handleStateUpdate,
    );
    this.appSettingsState.eventTarget.addEventListener(
      "state-update",
      this.handleStateUpdate,
    );
    this.sync();
  }

  dispose() {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;

    this.sessionsState.eventTarget.removeEventListener(
      "state-update",
      this.handleStateUpdate,
    );
    this.appSettingsState.eventTarget.removeEventListener(
      "state-update",
      this.handleStateUpdate,
    );
    this.stopBlockerIfNeeded();
    this.clearAllPendingDockBounces();
    this.clearDockBadge();
  }

  private readonly handleStateUpdate = () => {
    this.sync();
  };

  private sync() {
    if (this.isDisposed) {
      return;
    }

    const hasRunningSession = Object.values(this.sessionsState.state).some(
      (session) => session.status === "running",
    );

    const shouldBlock =
      this.appSettingsState.state.preventSleep && hasRunningSession;

    if (shouldBlock) {
      this.startBlockerIfNeeded();
    } else {
      this.stopBlockerIfNeeded();
    }

    this.syncDockAttention();
  }

  private syncDockAttention() {
    if (process.platform !== "darwin") {
      return;
    }

    const current = new Map<string, SessionStatus>();
    for (const [id, session] of Object.entries(this.sessionsState.state)) {
      current.set(id, session.status);
    }

    for (const [sessionId, pending] of [...this.pendingDockBounces.entries()]) {
      if (current.get(sessionId) !== pending.expectedStatus) {
        clearTimeout(pending.timeoutId);
        this.pendingDockBounces.delete(sessionId);
      }
    }

    if (!this.appSettingsState.state.dockBounceOnAttention) {
      this.clearAllPendingDockBounces();
    }

    try {
      if (this.appSettingsState.state.dockBadgeForAttention) {
        const n = [...current.values()].filter((s) =>
          ATTENTION_STATUSES.has(s),
        ).length;
        app.setBadgeCount(n);
      } else {
        app.setBadgeCount(0);
      }
    } catch (error) {
      log.error("Failed to update dock badge", { error });
    }

    const bounceEnabled = this.appSettingsState.state.dockBounceOnAttention;

    if (this.sessionStatusSnapshot !== null && bounceEnabled) {
      for (const [sessionId, newStatus] of current) {
        const oldStatus = this.sessionStatusSnapshot.get(sessionId);
        const wasAttention =
          oldStatus !== undefined && ATTENTION_STATUSES.has(oldStatus);
        const isAttention = ATTENTION_STATUSES.has(newStatus);
        if (!wasAttention && isAttention) {
          this.scheduleDeferredDockBounce(sessionId, newStatus);
          break;
        }
      }
    }

    this.sessionStatusSnapshot = new Map(current);
  }

  private scheduleDeferredDockBounce(
    sessionId: string,
    expectedStatus: SessionStatus,
  ) {
    const existing = this.pendingDockBounces.get(sessionId);
    if (existing) {
      clearTimeout(existing.timeoutId);
    }

    const timeoutId = setTimeout(() => {
      this.pendingDockBounces.delete(sessionId);
      if (this.isDisposed || process.platform !== "darwin") {
        return;
      }
      if (!this.appSettingsState.state.dockBounceOnAttention) {
        return;
      }
      if (BrowserWindow.getFocusedWindow() != null) {
        return;
      }
      const session = this.sessionsState.state[sessionId];
      if (!session || session.status !== expectedStatus) {
        return;
      }
      try {
        app.dock?.bounce("informational");
      } catch (error) {
        log.error("Failed to bounce dock", { error });
      }
    }, DOCK_BOUNCE_DELAY_MS);

    this.pendingDockBounces.set(sessionId, { timeoutId, expectedStatus });
  }

  private clearAllPendingDockBounces() {
    for (const pending of this.pendingDockBounces.values()) {
      clearTimeout(pending.timeoutId);
    }
    this.pendingDockBounces.clear();
  }

  private clearDockBadge() {
    if (process.platform !== "darwin") {
      return;
    }
    try {
      app.setBadgeCount(0);
    } catch (error) {
      log.error("Failed to clear dock badge", { error });
    }
  }

  private startBlockerIfNeeded() {
    if (this.blockerId !== null && powerSaveBlocker.isStarted(this.blockerId)) {
      return;
    }

    try {
      this.blockerId = powerSaveBlocker.start(BLOCKER_TYPE);
      log.info("Power save blocker enabled", {
        blockerId: this.blockerId,
        type: BLOCKER_TYPE,
      });
    } catch (error) {
      this.blockerId = null;
      log.error("Failed to enable power save blocker", { error });
    }
  }

  private stopBlockerIfNeeded() {
    const blockerId = this.blockerId;
    if (blockerId === null) {
      return;
    }

    this.blockerId = null;

    try {
      if (powerSaveBlocker.isStarted(blockerId)) {
        powerSaveBlocker.stop(blockerId);
      }
      log.info("Power save blocker disabled", {
        blockerId,
      });
    } catch (error) {
      log.error("Failed to disable power save blocker", { error, blockerId });
    }
  }
}
