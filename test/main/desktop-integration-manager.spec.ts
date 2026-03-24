import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineAppSettingsState } from "../../src/main/app-settings";
import { DesktopIntegrationManager } from "../../src/main/desktop-integration-manager";
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

const appMock = vi.hoisted(() => ({
  setBadgeCount: vi.fn(),
  dock: {
    bounce: vi.fn(),
  },
}));

const browserWindowMock = vi.hoisted(() => ({
  getFocusedWindow: vi.fn<() => Electron.BrowserWindow | null>(),
}));

vi.mock("electron", () => ({
  powerSaveBlocker: powerSaveBlockerMock,
  app: appMock,
  BrowserWindow: browserWindowMock,
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

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

describe("DesktopIntegrationManager", () => {
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    vi.clearAllMocks();
    originalPlatform = process.platform;
    powerSaveBlockerMock.start.mockReturnValue(100);
    powerSaveBlockerMock.isStarted.mockReturnValue(true);
    browserWindowMock.getFocusedWindow.mockReturnValue(null);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it("activates blocker when first running session appears", () => {
    const sessionsState = defineSessionServiceState();
    const appSettingsState = defineAppSettingsState();
    const manager = new DesktopIntegrationManager(
      sessionsState,
      appSettingsState,
    );

    sessionsState.updateState((state) => {
      state["session-1"] = makeLocalTerminalSession("session-1", "running");
    });

    expect(powerSaveBlockerMock.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerMock.start).toHaveBeenCalledWith(
      "prevent-display-sleep",
    );
    expect(powerSaveBlockerMock.stop).not.toHaveBeenCalled();

    manager.dispose();
  });

  it("does not start blocker for idle or starting sessions", () => {
    const sessionsState = defineSessionServiceState();
    const appSettingsState = defineAppSettingsState();
    const manager = new DesktopIntegrationManager(
      sessionsState,
      appSettingsState,
    );

    sessionsState.updateState((state) => {
      state["session-1"] = makeLocalTerminalSession("session-1", "idle");
      state["session-2"] = makeLocalTerminalSession("session-2", "starting");
    });

    expect(powerSaveBlockerMock.start).not.toHaveBeenCalled();

    manager.dispose();
  });

  it("does not re-start while blocker is already active", () => {
    const sessionsState = defineSessionServiceState();
    const appSettingsState = defineAppSettingsState();
    const manager = new DesktopIntegrationManager(
      sessionsState,
      appSettingsState,
    );

    sessionsState.updateState((state) => {
      state["session-1"] = makeLocalTerminalSession("session-1", "running");
    });
    sessionsState.updateState((state) => {
      state["session-1"].title = "Updated";
    });

    expect(powerSaveBlockerMock.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerMock.isStarted).toHaveBeenCalledWith(100);

    manager.dispose();
  });

  it("deactivates blocker when the last active session becomes stopped", () => {
    const sessionsState = defineSessionServiceState();
    const appSettingsState = defineAppSettingsState();
    const manager = new DesktopIntegrationManager(
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
    const manager = new DesktopIntegrationManager(
      sessionsState,
      appSettingsState,
    );

    sessionsState.updateState((state) => {
      state["session-1"] = makeLocalTerminalSession("session-1", "running");
      state["session-2"] = makeLocalTerminalSession("session-2", "running");
    });
    sessionsState.updateState((state) => {
      state["session-1"].status = "stopped";
    });

    expect(powerSaveBlockerMock.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerMock.stop).not.toHaveBeenCalled();

    manager.dispose();
  });

  it("reactivates blocker after running stops then starts again", () => {
    const sessionsState = defineSessionServiceState();
    powerSaveBlockerMock.start
      .mockReturnValueOnce(101)
      .mockReturnValueOnce(102);
    const appSettingsState = defineAppSettingsState();
    const manager = new DesktopIntegrationManager(
      sessionsState,
      appSettingsState,
    );

    sessionsState.updateState((state) => {
      state["session-1"] = makeLocalTerminalSession("session-1", "running");
    });
    sessionsState.updateState((state) => {
      state["session-1"].status = "idle";
    });
    sessionsState.updateState((state) => {
      state["session-1"].status = "running";
    });

    expect(powerSaveBlockerMock.start).toHaveBeenCalledTimes(2);
    expect(powerSaveBlockerMock.stop).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerMock.stop).toHaveBeenCalledWith(101);

    manager.dispose();
  });

  it("dispose stops active blocker and unsubscribes from state updates", () => {
    const sessionsState = defineSessionServiceState();
    const appSettingsState = defineAppSettingsState();
    const manager = new DesktopIntegrationManager(
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
    const manager = new DesktopIntegrationManager(
      sessionsState,
      appSettingsState,
    );

    manager.dispose();
    manager.dispose();

    expect(powerSaveBlockerMock.start).not.toHaveBeenCalled();
    expect(powerSaveBlockerMock.stop).not.toHaveBeenCalled();
  });
});

describe("DesktopIntegrationManager macOS dock", () => {
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    originalPlatform = process.platform;
    setPlatform("darwin");
    powerSaveBlockerMock.start.mockReturnValue(100);
    powerSaveBlockerMock.isStarted.mockReturnValue(true);
    browserWindowMock.getFocusedWindow.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    setPlatform(originalPlatform);
  });

  it("sets dock badge to the number of sessions awaiting input or approval", () => {
    const sessionsState = defineSessionServiceState();
    const appSettingsState = defineAppSettingsState();
    const manager = new DesktopIntegrationManager(
      sessionsState,
      appSettingsState,
    );

    sessionsState.updateState((state) => {
      state["session-a"] = makeLocalTerminalSession(
        "session-a",
        "awaiting_user_response",
      );
      state["session-b"] = makeLocalTerminalSession(
        "session-b",
        "awaiting_approval",
      );
      state["session-c"] = makeLocalTerminalSession("session-c", "running");
    });

    expect(appMock.setBadgeCount).toHaveBeenCalledWith(2);

    manager.dispose();
  });

  it("clears dock badge when dock badge setting is disabled", () => {
    const sessionsState = defineSessionServiceState();
    const appSettingsState = defineAppSettingsState();
    const manager = new DesktopIntegrationManager(
      sessionsState,
      appSettingsState,
    );

    sessionsState.updateState((state) => {
      state["session-a"] = makeLocalTerminalSession(
        "session-a",
        "awaiting_user_response",
      );
    });

    expect(appMock.setBadgeCount).toHaveBeenLastCalledWith(1);

    appSettingsState.updateState((s) => {
      s.dockBadgeForAttention = false;
    });

    expect(appMock.setBadgeCount).toHaveBeenLastCalledWith(0);

    manager.dispose();
  });

  it("does not bounce on first sync when sessions are already awaiting", () => {
    const sessionsState = defineSessionServiceState();
    sessionsState.updateState((state) => {
      state["session-1"] = makeLocalTerminalSession(
        "session-1",
        "awaiting_user_response",
      );
    });
    const appSettingsState = defineAppSettingsState();
    appSettingsState.updateState((s) => {
      s.dockBounceOnAttention = true;
    });

    new DesktopIntegrationManager(sessionsState, appSettingsState);

    expect(appMock.dock.bounce).not.toHaveBeenCalled();
  });

  it("bounces dock when a session transitions to awaiting and app is not focused", () => {
    const sessionsState = defineSessionServiceState();
    const appSettingsState = defineAppSettingsState();
    appSettingsState.updateState((s) => {
      s.dockBounceOnAttention = true;
    });
    const manager = new DesktopIntegrationManager(
      sessionsState,
      appSettingsState,
    );

    sessionsState.updateState((state) => {
      state["session-1"] = makeLocalTerminalSession("session-1", "idle");
    });
    sessionsState.updateState((state) => {
      state["session-1"].status = "awaiting_user_response";
    });

    expect(appMock.dock.bounce).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);

    expect(appMock.dock.bounce).toHaveBeenCalledTimes(1);
    expect(appMock.dock.bounce).toHaveBeenCalledWith("informational");

    manager.dispose();
  });

  it("does not bounce when a BrowserWindow has focus", () => {
    const sessionsState = defineSessionServiceState();
    const appSettingsState = defineAppSettingsState();
    appSettingsState.updateState((s) => {
      s.dockBounceOnAttention = true;
    });
    const manager = new DesktopIntegrationManager(
      sessionsState,
      appSettingsState,
    );

    sessionsState.updateState((state) => {
      state["session-1"] = makeLocalTerminalSession("session-1", "idle");
    });

    browserWindowMock.getFocusedWindow.mockReturnValue(
      {} as Electron.BrowserWindow,
    );

    sessionsState.updateState((state) => {
      state["session-1"].status = "awaiting_user_response";
    });

    vi.advanceTimersByTime(2000);

    expect(appMock.dock.bounce).not.toHaveBeenCalled();

    manager.dispose();
  });

  it("does not bounce when dock bounce setting is disabled", () => {
    const sessionsState = defineSessionServiceState();
    const appSettingsState = defineAppSettingsState();
    appSettingsState.updateState((s) => {
      s.dockBounceOnAttention = false;
    });
    const manager = new DesktopIntegrationManager(
      sessionsState,
      appSettingsState,
    );

    sessionsState.updateState((state) => {
      state["session-1"] = makeLocalTerminalSession("session-1", "idle");
    });
    sessionsState.updateState((state) => {
      state["session-1"].status = "awaiting_user_response";
    });

    vi.advanceTimersByTime(2000);

    expect(appMock.dock.bounce).not.toHaveBeenCalled();

    manager.dispose();
  });

  it("does not bounce if attention clears before the delay elapses", () => {
    const sessionsState = defineSessionServiceState();
    const appSettingsState = defineAppSettingsState();
    appSettingsState.updateState((s) => {
      s.dockBounceOnAttention = true;
    });
    const manager = new DesktopIntegrationManager(
      sessionsState,
      appSettingsState,
    );

    sessionsState.updateState((state) => {
      state["session-1"] = makeLocalTerminalSession("session-1", "idle");
    });
    sessionsState.updateState((state) => {
      state["session-1"].status = "awaiting_user_response";
    });

    vi.advanceTimersByTime(1999);
    sessionsState.updateState((state) => {
      state["session-1"].status = "idle";
    });

    vi.advanceTimersByTime(10_000);

    expect(appMock.dock.bounce).not.toHaveBeenCalled();

    manager.dispose();
  });

  it("does not bounce after dispose while the delay is pending", () => {
    const sessionsState = defineSessionServiceState();
    const appSettingsState = defineAppSettingsState();
    appSettingsState.updateState((s) => {
      s.dockBounceOnAttention = true;
    });
    const manager = new DesktopIntegrationManager(
      sessionsState,
      appSettingsState,
    );

    sessionsState.updateState((state) => {
      state["session-1"] = makeLocalTerminalSession("session-1", "idle");
    });
    sessionsState.updateState((state) => {
      state["session-1"].status = "awaiting_user_response";
    });

    vi.advanceTimersByTime(500);
    manager.dispose();
    vi.advanceTimersByTime(2000);

    expect(appMock.dock.bounce).not.toHaveBeenCalled();
  });

  it("clears dock badge on dispose", () => {
    const sessionsState = defineSessionServiceState();
    const appSettingsState = defineAppSettingsState();
    const manager = new DesktopIntegrationManager(
      sessionsState,
      appSettingsState,
    );

    sessionsState.updateState((state) => {
      state["session-a"] = makeLocalTerminalSession(
        "session-a",
        "awaiting_user_response",
      );
    });

    vi.clearAllMocks();

    manager.dispose();

    expect(appMock.setBadgeCount).toHaveBeenCalledWith(0);
  });
});
