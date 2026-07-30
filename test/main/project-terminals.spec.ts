import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectTerminalsManager,
  type ProjectTerminalsState,
  type ProjectTerminalWorkspaceData,
} from "../../src/main/project-terminals";
import {
  removeLegacyLocalTerminalSessions,
  type SessionServiceState,
} from "../../src/main/sessions/state";

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
        stoppedByUser: boolean;
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

function createProjectTerminalsState() {
  const state: Record<string, ProjectTerminalWorkspaceData> = {};
  const projectTerminalsState = {
    state,
    updateState: (updater: (draft: typeof state) => void) => {
      updater(state);
    },
  } as unknown as ProjectTerminalsState;

  return { state, projectTerminalsState };
}

function createSessionsState() {
  const state = {
    legacy: { type: "local-terminal" },
    keep: { type: "claude-local-terminal" },
  } as unknown as SessionServiceState["state"];

  const sessionsState = {
    state,
    updateState: (updater: (draft: typeof state) => void) => {
      updater(state);
    },
  } as unknown as SessionServiceState;

  return { state, sessionsState };
}

describe("ProjectTerminalsManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalSessionSpies.callbacks = [];
    terminalSessionSpies.bufferedOutput = "";
  });

  it("creates the first project terminal on ensure", () => {
    const { state, projectTerminalsState } = createProjectTerminalsState();
    const manager = new ProjectTerminalsManager(projectTerminalsState);

    manager.ensureWorkspace({ cwd: "/tmp/project" });

    const workspace = state["/tmp/project"];
    expect(workspace).toBeDefined();
    expect(workspace.order).toHaveLength(1);
    expect(workspace.selectedTerminalId).toBe(workspace.order[0]);
    expect(workspace.terminals[workspace.order[0]]?.title).toBe("Terminal 1");
    expect(terminalSessionSpies.start).toHaveBeenCalledTimes(1);
    expect(manager.liveTerminals.size).toBe(1);
  });

  it("supports multiple concurrent terminals in the same cwd", () => {
    const { state, projectTerminalsState } = createProjectTerminalsState();
    const manager = new ProjectTerminalsManager(projectTerminalsState);

    manager.ensureWorkspace({ cwd: "/tmp/project" });
    const firstTerminalId = state["/tmp/project"]?.selectedTerminalId as string;

    const { terminalId: secondTerminalId } = manager.createTerminal({
      cwd: "/tmp/project",
    });

    expect(state["/tmp/project"]?.order).toEqual([
      firstTerminalId,
      secondTerminalId,
    ]);
    expect(state["/tmp/project"]?.selectedTerminalId).toBe(secondTerminalId);
    expect(manager.liveTerminals.size).toBe(2);
    expect(terminalSessionSpies.start).toHaveBeenCalledTimes(2);
  });

  it("selects an adjacent terminal and allows the workspace to go empty", async () => {
    const { state, projectTerminalsState } = createProjectTerminalsState();
    const manager = new ProjectTerminalsManager(projectTerminalsState);

    manager.ensureWorkspace({ cwd: "/tmp/project" });
    const firstTerminalId = state["/tmp/project"]?.selectedTerminalId as string;
    const { terminalId: secondTerminalId } = manager.createTerminal({
      cwd: "/tmp/project",
    });

    await manager.closeTerminal({
      cwd: "/tmp/project",
      terminalId: secondTerminalId,
    });

    expect(state["/tmp/project"]?.selectedTerminalId).toBe(firstTerminalId);
    expect(state["/tmp/project"]?.order).toEqual([firstTerminalId]);

    await manager.closeTerminal({
      cwd: "/tmp/project",
      terminalId: firstTerminalId,
    });

    expect(state["/tmp/project"]?.order).toEqual([]);
    expect(state["/tmp/project"]?.selectedTerminalId).toBeNull();
    expect(manager.liveTerminals.size).toBe(0);
  });

  it("restarts the selected terminal when the workspace is ensured again", async () => {
    const { state, projectTerminalsState } = createProjectTerminalsState();
    const manager = new ProjectTerminalsManager(projectTerminalsState);

    manager.ensureWorkspace({ cwd: "/tmp/project" });
    const firstTerminalId = state["/tmp/project"]?.selectedTerminalId as string;

    terminalSessionSpies.callbacks[0]?.onExit({
      exitCode: 0,
      stoppedByUser: false,
    });
    await vi.waitFor(() => {
      expect(manager.liveTerminals.has(firstTerminalId)).toBe(false);
    });

    manager.ensureWorkspace({ cwd: "/tmp/project" });

    expect(terminalSessionSpies.start).toHaveBeenCalledTimes(2);
    expect(manager.liveTerminals.has(firstTerminalId)).toBe(true);
  });

  it("stops live terminals and removes workspace state when deleting a project workspace", async () => {
    const { state, projectTerminalsState } = createProjectTerminalsState();
    const manager = new ProjectTerminalsManager(projectTerminalsState);

    manager.ensureWorkspace({ cwd: "/tmp/project" });
    manager.createTerminal({ cwd: "/tmp/project" });

    expect(state["/tmp/project"]?.order).toHaveLength(2);
    expect(manager.liveTerminals.size).toBe(2);

    await manager.deleteWorkspace("/tmp/project");

    expect(state["/tmp/project"]).toBeUndefined();
    expect(manager.liveTerminals.size).toBe(0);
    expect(terminalSessionSpies.stop).toHaveBeenCalledTimes(2);
  });
});

describe("removeLegacyLocalTerminalSessions", () => {
  it("removes legacy standalone terminal sessions from persisted session state", () => {
    const { state, sessionsState } = createSessionsState();

    const removedCount = removeLegacyLocalTerminalSessions(sessionsState);

    expect(removedCount).toBe(1);
    expect(state.legacy).toBeUndefined();
    expect(state.keep).toBeDefined();
  });
});
