import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexSessionLogFileManager } from "../../src/main/codex-session-log-file-manager";
import {
  type CodexLocalTerminalSessionData,
  CodexSessionsManager,
} from "../../src/main/sessions/codex.session";
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
  const state: Record<string, CodexLocalTerminalSessionData> = {};
  const sessionsState = {
    state,
    updateState: (updater: (draft: typeof state) => void) => {
      updater(state);
    },
  } as unknown as SessionServiceState;

  return { state, sessionsState };
}

function createManager(opts?: {
  initialPrompt?: string;
  sessionLogFileManager?: CodexSessionLogFileManager;
}) {
  const { state, sessionsState } = createSessionsState();
  const manager = opts?.sessionLogFileManager
    ? new CodexSessionsManager({
        state: sessionsState,
        sessionLogFileManager: opts.sessionLogFileManager,
      })
    : new CodexSessionsManager(sessionsState);
  const sessionId = "session-codex-1";
  const startupConfig: CodexLocalTerminalSessionData["startupConfig"] = {
    cwd: "/tmp",
    modelReasoningEffort: "high",
    permissionMode: "default",
    initialPrompt: opts?.initialPrompt ?? "/plan summarize recent commits",
    model: undefined,
    configOverrides: undefined,
  };

  state[sessionId] = {
    sessionId,
    type: "codex-local-terminal",
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    status: "stopped",
    title: "Codex Session",
    startupConfig,
    bufferedOutput: "",
  };

  return { manager, sessionId, state };
}

describe("CodexSessionsManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    terminalSessionSpies.callbacks = [];
    terminalSessionSpies.bufferedOutput = "";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("submits deferred /plan prompt after switching to running", async () => {
    const { manager, sessionId } = createManager();

    manager.startLiveSession({
      sessionId,
      cwd: "/tmp",
      modelReasoningEffort: "high",
      permissionMode: "default",
      initialPrompt: "/plan summarize recent commits",
    });

    const callbacks = terminalSessionSpies.callbacks[0];
    callbacks?.onStatusChange("running");
    expect(terminalSessionSpies.write).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(terminalSessionSpies.write).toHaveBeenNthCalledWith(1, "\x1b[Z");
    expect(terminalSessionSpies.write).toHaveBeenNthCalledWith(
      2,
      "summarize recent commits",
    );

    await vi.advanceTimersByTimeAsync(100);
    expect(terminalSessionSpies.write).toHaveBeenNthCalledWith(3, "\x1b[13u");

    await manager.stopLiveSession(sessionId);
  });

  it("starts codex with --no-alt-screen", async () => {
    const { manager, sessionId } = createManager({
      initialPrompt: undefined,
    });

    manager.startLiveSession({
      sessionId,
      cwd: "/tmp",
      modelReasoningEffort: "high",
      permissionMode: "default",
      initialPrompt: undefined,
    });

    const startCall = terminalSessionSpies.start.mock.calls[0]?.[0] as
      | { args?: string[]; env?: Record<string, string> }
      | undefined;
    expect(startCall?.args?.[0]).toBe("--no-alt-screen");
    expect(startCall?.env).toBeUndefined();

    await manager.stopLiveSession(sessionId);
  });

  it("sets session recording env vars when a codex log file manager is provided", async () => {
    const sessionLogFileManager = {
      create: vi.fn(() => "/tmp/claude-state/codex-session-codex-1.jsonl"),
      cleanup: vi.fn(),
    } as unknown as CodexSessionLogFileManager;
    const { manager, sessionId } = createManager({
      initialPrompt: undefined,
      sessionLogFileManager,
    });

    manager.startLiveSession({
      sessionId,
      cwd: "/tmp",
      modelReasoningEffort: "high",
      permissionMode: "default",
      initialPrompt: undefined,
    });

    const startCall = terminalSessionSpies.start.mock.calls[0]?.[0] as
      | { env?: Record<string, string> }
      | undefined;
    expect(sessionLogFileManager.create).toHaveBeenCalledWith(sessionId);
    expect(startCall?.env).toEqual({
      CODEX_TUI_RECORD_SESSION: "1",
      CODEX_TUI_SESSION_LOG_PATH:
        "/tmp/claude-state/codex-session-codex-1.jsonl",
    });

    await manager.stopLiveSession(sessionId);
    expect(sessionLogFileManager.cleanup).toHaveBeenCalledWith(
      "/tmp/claude-state/codex-session-codex-1.jsonl",
    );
  });

  it("does not defer-submit prompt when it is not /plan mode", async () => {
    const { manager, sessionId } = createManager();

    manager.startLiveSession({
      sessionId,
      cwd: "/tmp",
      modelReasoningEffort: "high",
      permissionMode: "default",
      initialPrompt: "summarize recent commits",
    });

    const callbacks = terminalSessionSpies.callbacks[0];
    callbacks?.onStatusChange("running");
    await vi.advanceTimersByTimeAsync(300);
    expect(terminalSessionSpies.write).not.toHaveBeenCalled();

    await manager.stopLiveSession(sessionId);
  });

  it("submits deferred /plan prompt only once", async () => {
    const { manager, sessionId } = createManager();

    manager.startLiveSession({
      sessionId,
      cwd: "/tmp",
      modelReasoningEffort: "high",
      permissionMode: "default",
      initialPrompt: "/plan summarize recent commits",
    });

    const callbacks = terminalSessionSpies.callbacks[0];
    callbacks?.onStatusChange("running");
    await vi.advanceTimersByTimeAsync(200);

    callbacks?.onStatusChange("running");
    await vi.advanceTimersByTimeAsync(200);
    expect(terminalSessionSpies.write).toHaveBeenCalledTimes(3);
    expect(terminalSessionSpies.write).toHaveBeenNthCalledWith(1, "\x1b[Z");
    expect(terminalSessionSpies.write).toHaveBeenNthCalledWith(
      2,
      "summarize recent commits",
    );
    expect(terminalSessionSpies.write).toHaveBeenNthCalledWith(3, "\x1b[13u");

    await manager.stopLiveSession(sessionId);
  });

  it("maps running terminal status to idle session status", async () => {
    const { manager, sessionId, state } = createManager({
      initialPrompt: undefined,
    });

    manager.startLiveSession({
      sessionId,
      cwd: "/tmp",
      modelReasoningEffort: "high",
      permissionMode: "default",
      initialPrompt: undefined,
    });
    const callbacks = terminalSessionSpies.callbacks[0];
    const session = state[sessionId];

    callbacks?.onStatusChange("starting");
    expect(session.status).toBe("starting");

    callbacks?.onStatusChange("running");
    expect(session.status).toBe("idle");

    callbacks?.onStatusChange("stopping");
    expect(session.status).toBe("stopping");

    callbacks?.onStatusChange("error");
    expect(session.status).toBe("error");

    callbacks?.onStatusChange("stopped");
    expect(session.status).toBe("stopped");
  });

  it("does not change status on output events", async () => {
    const { manager, sessionId, state } = createManager({
      initialPrompt: undefined,
    });

    manager.startLiveSession({
      sessionId,
      cwd: "/tmp",
      modelReasoningEffort: "high",
      permissionMode: "default",
      initialPrompt: undefined,
    });
    const callbacks = terminalSessionSpies.callbacks[0];
    const session = state[sessionId];

    session.status = "idle";
    callbacks?.onData({ chunk: "working...", bufferedOutput: "working..." });
    expect(session.status).toBe("idle");

    callbacks?.onStatusChange("running");
    expect(session.status).toBe("idle");

    callbacks?.onData({ chunk: "still working...", bufferedOutput: "..." });
    expect(session.status).toBe("idle");
  });

  it("dispose stops all live sessions", async () => {
    const { state, sessionsState } = createSessionsState();
    const manager = new CodexSessionsManager(sessionsState);
    const startupConfig: CodexLocalTerminalSessionData["startupConfig"] = {
      cwd: "/tmp",
      modelReasoningEffort: "high",
      permissionMode: "default",
      model: undefined,
      initialPrompt: undefined,
      configOverrides: undefined,
    };

    for (const sessionId of ["session-codex-1", "session-codex-2"]) {
      state[sessionId] = {
        sessionId,
        type: "codex-local-terminal",
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        status: "stopped",
        title: "Codex Session",
        startupConfig,
        bufferedOutput: "",
      };
      manager.startLiveSession({
        sessionId,
        cwd: "/tmp",
        modelReasoningEffort: "high",
        permissionMode: "default",
        initialPrompt: undefined,
      });
    }

    await manager.dispose();

    expect(terminalSessionSpies.stop).toHaveBeenCalledTimes(2);
    expect(manager.liveSessions.size).toBe(0);
  });
});
