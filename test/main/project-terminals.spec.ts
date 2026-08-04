import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("ProjectTerminalsManager command presets", () => {
  let projectDir: string;

  /** OSC 133 precmd marker: what the shell integration emits at each prompt. */
  const PROMPT_MARKER = "\u001b]133;A\u0007";

  const writeCommands = async (commands: string) => {
    await mkdir(path.join(projectDir, ".agent-ui"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".agent-ui", "settings.jsonc"),
      `{ "commands": ${commands} }`,
      "utf-8",
    );
  };

  /** Emits a prompt marker and waits out the paint delay before the flush. */
  const emitPrompt = async (callbackIndex = 0) => {
    terminalSessionSpies.callbacks[callbackIndex]?.onData({
      chunk: PROMPT_MARKER,
      bufferedOutput: PROMPT_MARKER,
    });
    await vi.waitFor(() => {
      expect(terminalSessionSpies.write).toHaveBeenCalled();
    });
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    terminalSessionSpies.callbacks = [];
    projectDir = path.join(
      tmpdir(),
      `project-commands-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("opens a titled terminal and types the command once the shell prompts", async () => {
    await writeCommands(`[{ "name": "Dev server", "run": "just dev" }]`);
    const { state, projectTerminalsState } = createProjectTerminalsState();
    const manager = new ProjectTerminalsManager(projectTerminalsState);

    const { terminalId } = await manager.runCommand({
      cwd: projectDir,
      commandId: "dev-server",
    });

    const terminal = state[projectDir]?.terminals[terminalId];
    expect(terminal?.title).toBe("Dev server");
    expect(terminal?.commandId).toBe("dev-server");
    // Nothing is typed until the shell says it is ready for input.
    expect(terminalSessionSpies.write).not.toHaveBeenCalled();

    await emitPrompt();

    expect(terminalSessionSpies.write).toHaveBeenCalledWith("just dev\n");
  });

  it("focuses the existing terminal for a singleton preset", async () => {
    await writeCommands(
      `[{ "name": "Dev server", "run": "just dev", "singleton": true }]`,
    );
    const { state, projectTerminalsState } = createProjectTerminalsState();
    const manager = new ProjectTerminalsManager(projectTerminalsState);

    const first = await manager.runCommand({
      cwd: projectDir,
      commandId: "dev-server",
    });
    await emitPrompt();
    const second = await manager.runCommand({
      cwd: projectDir,
      commandId: "dev-server",
    });

    expect(second.terminalId).toBe(first.terminalId);
    expect(state[projectDir]?.order).toHaveLength(1);
    expect(terminalSessionSpies.start).toHaveBeenCalledTimes(1);
  });

  it("opens a second terminal when the preset is not a singleton", async () => {
    await writeCommands(`[{ "name": "Dev server", "run": "just dev" }]`);
    const { state, projectTerminalsState } = createProjectTerminalsState();
    const manager = new ProjectTerminalsManager(projectTerminalsState);

    await manager.runCommand({ cwd: projectDir, commandId: "dev-server" });
    await manager.runCommand({ cwd: projectDir, commandId: "dev-server" });

    expect(state[projectDir]?.order).toHaveLength(2);
  });

  it("rejects a preset the file no longer defines", async () => {
    await writeCommands(`[{ "name": "Dev server", "run": "just dev" }]`);
    const { projectTerminalsState } = createProjectTerminalsState();
    const manager = new ProjectTerminalsManager(projectTerminalsState);

    await expect(
      manager.runCommand({ cwd: projectDir, commandId: "deploy" }),
    ).rejects.toThrow(/no longer defined/);
  });

  it("re-runs the preset behind an existing terminal", async () => {
    await writeCommands(`[{ "name": "Dev server", "run": "just dev" }]`);
    const { projectTerminalsState } = createProjectTerminalsState();
    const manager = new ProjectTerminalsManager(projectTerminalsState);

    const { terminalId } = await manager.runCommand({
      cwd: projectDir,
      commandId: "dev-server",
    });
    await emitPrompt();
    terminalSessionSpies.write.mockClear();

    await manager.rerunCommand({ cwd: projectDir, terminalId });
    await emitPrompt();

    expect(terminalSessionSpies.write).toHaveBeenCalledWith("just dev\n");
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
