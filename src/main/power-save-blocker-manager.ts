import { powerSaveBlocker } from "electron";
import type { AppSettingsState } from "./app-settings";
import log from "./logger";
import type { SessionServiceState } from "./sessions/state";

const BLOCKER_TYPE = "prevent-display-sleep";

export class PowerSaveBlockerManager {
  private blockerId: number | null = null;
  private isDisposed = false;

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
  }

  private readonly handleStateUpdate = () => {
    this.sync();
  };

  private sync() {
    if (this.isDisposed) {
      return;
    }

    const hasActiveSessions = Object.values(this.sessionsState.state).some(
      (session) => session.status !== "stopped" && session.status !== "error",
    );

    const shouldBlock =
      this.appSettingsState.state.preventSleep && hasActiveSessions;

    if (shouldBlock) {
      this.startBlockerIfNeeded();
      return;
    }

    this.stopBlockerIfNeeded();
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
