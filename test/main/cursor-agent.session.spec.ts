import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CursorAgentSessionData,
  CursorAgentSessionsManager,
} from "../../src/main/sessions/cursor-agent.session";
import type { SessionServiceState } from "../../src/main/sessions/state";

type HookState =
  | "idle"
  | "working"
  | "awaiting_approval"
  | "awaiting_user_response"
  | "unknown";

const terminalSessionSpies = vi.hoisted(() => {
  return {
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    write: vi.fn(),
    resize: vi.fn(),
    status: "stopped" as
      | "starting"
      | "stopping"
      | "running"
      | "stopped"
      | "error",
    bufferedOutput: "",
    callbacks: [] as Array<{
      onStatusChange: (status: string) => void;
      onData: (payload: { chunk: string; bufferedOutput: string }) => void;
      onExit: (payload: {
        exitCode: number | null;
        signal?: number;
        errorMessage?: string;
      }) => void;
    }>,
  };
});

const activityMonitorSpies = vi.hoisted(() => {
  return {
    state: "unknown" as HookState,
    instances: [] as Array<{
      startMonitoring: ReturnType<typeof vi.fn>;
      stopMonitoring: ReturnType<typeof vi.fn>;
      callbacks: { onStatusChange: (status: HookState) => void };
    }>,
  };
});

vi.mock("../../src/main/terminal-session", () => ({
  createTerminalSession: vi.fn().mockImplementation((callbacks) => {
    terminalSessionSpies.callbacks.push({
      ...callbacks,
      onStatusChange: (status: string) => {
        terminalSessionSpies.status =
          status as typeof terminalSessionSpies.status;
        callbacks.onStatusChange(status);
      },
      onData: (payload: { chunk: string; bufferedOutput: string }) => {
        terminalSessionSpies.bufferedOutput = payload.bufferedOutput;
        callbacks.onData(payload);
      },
    });

    return {
      start: terminalSessionSpies.start,
      stop: terminalSessionSpies.stop,
      write: terminalSessionSpies.write,
      resize: terminalSessionSpies.resize,
      get status() {
        return terminalSessionSpies.status;
      },
      get bufferedOutput() {
        return terminalSessionSpies.bufferedOutput;
      },
    };
  }),
}));

vi.mock("../../src/main/cursor-activity-monitor", () => ({
  // biome-ignore lint/complexity/useArrowFunction: class constructor mock
  CursorActivityMonitor: vi.fn().mockImplementation(function (callbacks) {
    const instance = {
      startMonitoring: vi.fn().mockResolvedValue(undefined),
      stopMonitoring: vi.fn(),
      callbacks,
      getState: () => activityMonitorSpies.state,
    };
    activityMonitorSpies.instances.push(instance);
    return instance;
  }),
}));

function seedCursorSession(
  state: Record<string, CursorAgentSessionData>,
  sessionId: string,
) {
  state[sessionId] = {
    sessionId,
    type: "cursor-agent",
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    status: "stopped",
    title: "Cursor Session",
    startupConfig: {
      cwd: "/tmp/project",
      permissionMode: "default",
      initialPrompt: undefined,
    },
    cursorChatId: "chat-1",
    bufferedOutput: "",
  };
}

function createState(): SessionServiceState {
  const state = {} as Record<string, CursorAgentSessionData>;
  return {
    state,
    updateState: (updater) => updater(state),
  } as SessionServiceState;
}

describe("CursorAgentSessionsManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalSessionSpies.status = "stopped";
    terminalSessionSpies.bufferedOutput = "";
    terminalSessionSpies.callbacks = [];
    activityMonitorSpies.instances = [];
    activityMonitorSpies.state = "unknown";
  });

  it("derives status from terminal + cursor hook activity", async () => {
    const sessionsState = createState();
    seedCursorSession(
      sessionsState.state as Record<string, CursorAgentSessionData>,
      "session-1",
    );

    const manager = new CursorAgentSessionsManager({
      state: sessionsState,
      cursorConfigDir: "/tmp/cursor-config",
      cursorHookEventsFilePath: "/tmp/cursor-events.ndjson",
    });

    await manager.startLiveSession({
      sessionId: "session-1",
      cwd: "/tmp/project",
      permissionMode: "default",
      cursorChatId: "chat-1",
    });

    const monitor = activityMonitorSpies.instances[0];
    expect(monitor?.startMonitoring).toHaveBeenCalledWith({
      stateFilePath: "/tmp/cursor-events.ndjson",
      conversationId: "chat-1",
    });
    expect(terminalSessionSpies.start).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { CURSOR_CONFIG_DIR: "/tmp/cursor-config" },
      }),
    );

    const callbacks = terminalSessionSpies.callbacks[0];
    callbacks?.onStatusChange("running");
    expect(
      (sessionsState.state as Record<string, CursorAgentSessionData>)[
        "session-1"
      ]?.status,
    ).toBe("idle");

    monitor?.callbacks.onStatusChange("working");
    expect(
      (sessionsState.state as Record<string, CursorAgentSessionData>)[
        "session-1"
      ]?.status,
    ).toBe("running");

    monitor?.callbacks.onStatusChange("awaiting_user_response");
    expect(
      (sessionsState.state as Record<string, CursorAgentSessionData>)[
        "session-1"
      ]?.status,
    ).toBe("awaiting_user_response");
  });

  it("falls back to terminal-only status when hook monitor is unavailable", async () => {
    const sessionsState = createState();
    seedCursorSession(
      sessionsState.state as Record<string, CursorAgentSessionData>,
      "session-2",
    );

    const manager = new CursorAgentSessionsManager({
      state: sessionsState,
      cursorConfigDir: null,
      cursorHookEventsFilePath: null,
    });

    await manager.startLiveSession({
      sessionId: "session-2",
      cwd: "/tmp/project",
      permissionMode: "default",
      cursorChatId: undefined,
    });

    expect(activityMonitorSpies.instances).toHaveLength(0);
    const callbacks = terminalSessionSpies.callbacks[0];
    callbacks?.onStatusChange("running");
    expect(
      (sessionsState.state as Record<string, CursorAgentSessionData>)[
        "session-2"
      ]?.status,
    ).toBe("idle");
  });
});
