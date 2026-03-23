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
      callbacks: {
        onStatusChange: (status: HookState) => void;
        onHookEvent?: (event: {
          conversation_id?: string;
          session_id?: string;
        }) => void;
      };
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
    cursorChatId: undefined,
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

  it("creates sessions with an undefined cursor chat id by default", async () => {
    const sessionsState = createState();
    const manager = new CursorAgentSessionsManager({
      state: sessionsState,
      cursorConfigDir: "/tmp/cursor-config",
      sessionLogFileManager: {
        create: vi.fn(() => "/tmp/cursor-session-1.ndjson"),
        cleanup: vi.fn(),
      },
    });

    const sessionId = await manager.createSession({
      cwd: "/tmp/project",
      permissionMode: "default",
      sessionName: undefined,
      initialPrompt: undefined,
    });

    expect(
      (sessionsState.state as Record<string, CursorAgentSessionData>)[sessionId]
        ?.cursorChatId,
    ).toBeUndefined();
  });

  it("derives status from terminal + cursor hook activity", async () => {
    const sessionsState = createState();
    seedCursorSession(
      sessionsState.state as Record<string, CursorAgentSessionData>,
      "session-1",
    );
    const sessionLogFileManager = {
      create: vi.fn(() => "/tmp/cursor-session-1.ndjson"),
      cleanup: vi.fn(),
    };

    const manager = new CursorAgentSessionsManager({
      state: sessionsState,
      cursorConfigDir: "/tmp/cursor-config",
      sessionLogFileManager,
    });

    await manager.startLiveSession({
      sessionId: "session-1",
      cwd: "/tmp/project",
      permissionMode: "default",
      cursorChatId: undefined,
    });

    const monitor = activityMonitorSpies.instances[0];
    expect(monitor?.startMonitoring).toHaveBeenCalledWith({
      stateFilePath: "/tmp/cursor-session-1.ndjson",
    });
    expect(terminalSessionSpies.start).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          AGENT_UI_CURSOR_STATE_FILE: "/tmp/cursor-session-1.ndjson",
          CURSOR_CONFIG_DIR: "/tmp/cursor-config",
        },
      }),
    );

    const callbacks = terminalSessionSpies.callbacks[0];
    callbacks?.onStatusChange("running");
    expect(
      (sessionsState.state as Record<string, CursorAgentSessionData>)[
        "session-1"
      ]?.status,
    ).toBe("idle");

    monitor?.callbacks.onHookEvent?.({ conversation_id: "chat-1" });
    expect(
      (sessionsState.state as Record<string, CursorAgentSessionData>)[
        "session-1"
      ]?.cursorChatId,
    ).toBe("chat-1");

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

    await manager.stopLiveSession("session-1");
    expect(sessionLogFileManager.cleanup).toHaveBeenCalledWith(
      "/tmp/cursor-session-1.ndjson",
    );
  });

  it("reuses a hydrated cursor chat id on a later live start", async () => {
    const sessionsState = createState();
    seedCursorSession(
      sessionsState.state as Record<string, CursorAgentSessionData>,
      "session-2",
    );
    const sessionLogFileManager = {
      create: vi
        .fn()
        .mockReturnValueOnce("/tmp/cursor-session-2a.ndjson")
        .mockReturnValueOnce("/tmp/cursor-session-2b.ndjson"),
      cleanup: vi.fn(),
    };

    const manager = new CursorAgentSessionsManager({
      state: sessionsState,
      cursorConfigDir: "/tmp/cursor-config",
      sessionLogFileManager,
    });

    await manager.startLiveSession({
      sessionId: "session-2",
      cwd: "/tmp/project",
      permissionMode: "default",
      cursorChatId: undefined,
    });

    activityMonitorSpies.instances[0]?.callbacks.onHookEvent?.({
      session_id: "chat-2",
    });
    await manager.stopLiveSession("session-2");

    await manager.startLiveSession({
      sessionId: "session-2",
      cwd: "/tmp/project",
      permissionMode: "default",
      cursorChatId: (
        sessionsState.state as Record<string, CursorAgentSessionData>
      )["session-2"]?.cursorChatId,
    });

    expect(terminalSessionSpies.start.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        args: expect.arrayContaining(["--resume", "chat-2"]),
      }),
    );
  });

  it("falls back to terminal-only status when hook monitor is unavailable", async () => {
    const sessionsState = createState();
    seedCursorSession(
      sessionsState.state as Record<string, CursorAgentSessionData>,
      "session-3",
    );

    const manager = new CursorAgentSessionsManager({
      state: sessionsState,
      cursorConfigDir: null,
      sessionLogFileManager: null,
    });

    await manager.startLiveSession({
      sessionId: "session-3",
      cwd: "/tmp/project",
      permissionMode: "default",
      cursorChatId: undefined,
    });

    expect(activityMonitorSpies.instances).toHaveLength(0);
    const callbacks = terminalSessionSpies.callbacks[0];
    callbacks?.onStatusChange("running");
    expect(
      (sessionsState.state as Record<string, CursorAgentSessionData>)[
        "session-3"
      ]?.status,
    ).toBe("idle");
  });
});
