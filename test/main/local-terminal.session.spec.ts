import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type LocalTerminalSessionData,
  LocalTerminalSessionsManager,
} from "../../src/main/sessions/local-terminal.session";
import type { SessionServiceState } from "../../src/main/sessions/state";

const terminalSessionSpies = vi.hoisted(() => {
  return {
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    write: vi.fn(),
    resize: vi.fn(),
    clear: vi.fn(),
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

vi.mock("../../src/main/terminal-session", () => ({
  createTerminalSession: vi.fn().mockImplementation((callbacks) => {
    terminalSessionSpies.callbacks.push(callbacks);
    return terminalSessionSpies;
  }),
}));

function createSessionsState() {
  const state: Record<string, LocalTerminalSessionData> = {};
  const sessionsState = {
    state,
    updateState: (updater: (draft: typeof state) => void) => {
      updater(state);
    },
  } as unknown as SessionServiceState;

  return { state, sessionsState };
}

describe("LocalTerminalSessionsManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalSessionSpies.callbacks = [];
    terminalSessionSpies.bufferedOutput = "";
  });

  it("dispose stops all live sessions", async () => {
    const { state, sessionsState } = createSessionsState();
    const manager = new LocalTerminalSessionsManager(sessionsState);

    for (const sessionId of ["session-local-1", "session-local-2"]) {
      state[sessionId] = {
        sessionId,
        type: "local-terminal",
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        status: "stopped",
        title: "Local Terminal",
        startupConfig: {
          cwd: "/tmp",
        },
        bufferedOutput: "",
      };
      manager.startLiveSession({
        sessionId,
        cwd: "/tmp",
      });
    }

    await manager.dispose();

    expect(terminalSessionSpies.stop).toHaveBeenCalledTimes(2);
    expect(manager.liveSessions.size).toBe(0);
  });

  it("stores offlineBuffer when a local terminal is stopped", async () => {
    const { state, sessionsState } = createSessionsState();
    const manager = new LocalTerminalSessionsManager(sessionsState);

    state["session-local-1"] = {
      sessionId: "session-local-1",
      type: "local-terminal",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "stopped",
      title: "Local Terminal",
      startupConfig: {
        cwd: "/tmp",
      },
      bufferedOutput: "",
    };

    manager.startLiveSession({
      sessionId: "session-local-1",
      cwd: "/tmp",
    });

    terminalSessionSpies.callbacks[0]?.onData({
      chunk: "offline local output",
      bufferedOutput: "offline local output",
    });

    await manager.stopLiveSession("session-local-1");

    expect(state["session-local-1"]?.offlineBuffer).toContain(
      "offline local output",
    );
  });

  it("renames local terminal sessions", () => {
    const { state, sessionsState } = createSessionsState();
    const manager = new LocalTerminalSessionsManager(sessionsState);

    state["session-local-1"] = {
      sessionId: "session-local-1",
      type: "local-terminal",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "stopped",
      title: "Old Name",
      startupConfig: {
        cwd: "/tmp",
      },
      bufferedOutput: "",
    };

    manager.renameSession("session-local-1", "  Renamed Session  ");

    expect(state["session-local-1"]?.title).toBe("Renamed Session");
  });
});
