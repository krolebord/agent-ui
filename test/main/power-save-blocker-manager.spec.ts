import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineAppSettingsState } from "../../src/main/app-settings";
import { PowerSaveBlockerManager } from "../../src/main/power-save-blocker-manager";
import type { SessionStatus } from "../../src/main/sessions/common";
import { defineSessionServiceState } from "../../src/main/sessions/state";

const powerSaveBlockerMock = vi.hoisted(() => {
  return {
    start:
      vi.fn<
        (type: "prevent-app-suspension" | "prevent-display-sleep") => number
      >(),
    stop: vi.fn<(id: number) => void>(),
    isStarted: vi.fn<(id: number) => boolean>(),
  };
});

vi.mock("electron", () => ({
  powerSaveBlocker: powerSaveBlockerMock,
}));

function makeLocalTerminalSession(
  sessionId: string,
  status: SessionStatus,
): ReturnType<typeof defineSessionServiceState>["state"][string] {
  return {
    sessionId,
    type: "local-terminal",
    title: "Local Terminal",
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    status,
    startupConfig: {
      cwd: "/tmp",
    },
    bufferedOutput: "",
  };
}

describe("PowerSaveBlockerManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    powerSaveBlockerMock.start.mockReturnValue(100);
    powerSaveBlockerMock.isStarted.mockReturnValue(true);
  });

  it("activates blocker when first active session appears", () => {
    const sessionsState = defineSessionServiceState();
    const appSettingsState = defineAppSettingsState();
    const manager = new PowerSaveBlockerManager(
      sessionsState,
      appSettingsState,
    );

    sessionsState.updateState((state) => {
      state["session-1"] = makeLocalTerminalSession("session-1", "starting");
    });

    expect(powerSaveBlockerMock.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerMock.start).toHaveBeenCalledWith(
      "prevent-display-sleep",
    );
    expect(powerSaveBlockerMock.stop).not.toHaveBeenCalled();

    manager.dispose();
  });

  it("does not re-start while blocker is already active", () => {
    const sessionsState = defineSessionServiceState();
    const appSettingsState = defineAppSettingsState();
    const manager = new PowerSaveBlockerManager(
      sessionsState,
      appSettingsState,
    );

    sessionsState.updateState((state) => {
      state["session-1"] = makeLocalTerminalSession("session-1", "starting");
    });
    sessionsState.updateState((state) => {
      state["session-1"].status = "idle";
    });

    expect(powerSaveBlockerMock.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerMock.isStarted).toHaveBeenCalledWith(100);

    manager.dispose();
  });

  it("deactivates blocker when the last active session becomes stopped", () => {
    const sessionsState = defineSessionServiceState();
    const appSettingsState = defineAppSettingsState();
    const manager = new PowerSaveBlockerManager(
      sessionsState,
      appSettingsState,
    );

    sessionsState.updateState((state) => {
      state["session-1"] = makeLocalTerminalSession("session-1", "running");
    });
    sessionsState.updateState((state) => {
      state["session-1"].status = "stopped";
    });

    expect(powerSaveBlockerMock.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerMock.stop).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerMock.stop).toHaveBeenCalledWith(100);

    manager.dispose();
  });

  it("keeps blocker on when one active session remains", () => {
    const sessionsState = defineSessionServiceState();
    const appSettingsState = defineAppSettingsState();
    const manager = new PowerSaveBlockerManager(
      sessionsState,
      appSettingsState,
    );

    sessionsState.updateState((state) => {
      state["session-1"] = makeLocalTerminalSession("session-1", "running");
      state["session-2"] = makeLocalTerminalSession("session-2", "idle");
    });
    sessionsState.updateState((state) => {
      state["session-1"].status = "stopped";
    });

    expect(powerSaveBlockerMock.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerMock.stop).not.toHaveBeenCalled();

    manager.dispose();
  });

  it("reactivates blocker after all sessions go inactive and active again", () => {
    const sessionsState = defineSessionServiceState();
    powerSaveBlockerMock.start
      .mockReturnValueOnce(101)
      .mockReturnValueOnce(102);
    const appSettingsState = defineAppSettingsState();
    const manager = new PowerSaveBlockerManager(
      sessionsState,
      appSettingsState,
    );

    sessionsState.updateState((state) => {
      state["session-1"] = makeLocalTerminalSession("session-1", "running");
    });
    sessionsState.updateState((state) => {
      state["session-1"].status = "error";
    });
    sessionsState.updateState((state) => {
      state["session-1"].status = "awaiting_user_response";
    });

    expect(powerSaveBlockerMock.start).toHaveBeenCalledTimes(2);
    expect(powerSaveBlockerMock.stop).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerMock.stop).toHaveBeenCalledWith(101);

    manager.dispose();
  });

  it("dispose stops active blocker and unsubscribes from state updates", () => {
    const sessionsState = defineSessionServiceState();
    const appSettingsState = defineAppSettingsState();
    const manager = new PowerSaveBlockerManager(
      sessionsState,
      appSettingsState,
    );

    sessionsState.updateState((state) => {
      state["session-1"] = makeLocalTerminalSession("session-1", "running");
    });

    manager.dispose();

    expect(powerSaveBlockerMock.stop).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerMock.stop).toHaveBeenCalledWith(100);

    sessionsState.updateState((state) => {
      state["session-2"] = makeLocalTerminalSession("session-2", "running");
    });

    expect(powerSaveBlockerMock.start).toHaveBeenCalledTimes(1);
  });

  it("dispose is safe when blocker was never started", () => {
    const sessionsState = defineSessionServiceState();
    const appSettingsState = defineAppSettingsState();
    const manager = new PowerSaveBlockerManager(
      sessionsState,
      appSettingsState,
    );

    manager.dispose();
    manager.dispose();

    expect(powerSaveBlockerMock.start).not.toHaveBeenCalled();
    expect(powerSaveBlockerMock.stop).not.toHaveBeenCalled();
  });
});
