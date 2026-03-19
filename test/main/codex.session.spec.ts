import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexSessionLogFileManager } from "../../src/main/codex-session-log-file-manager";
import type { SessionTitleManager } from "../../src/main/session-title-manager";
import {
  type CodexLocalTerminalSessionData,
  CodexSessionsManager,
} from "../../src/main/sessions/codex.session";
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
    clear: vi.fn(),
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
        onLogEvent?: (event: unknown) => void;
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
      clear: terminalSessionSpies.clear,
      get status() {
        return terminalSessionSpies.status;
      },
      get bufferedOutput() {
        return terminalSessionSpies.bufferedOutput;
      },
    };
  }),
}));

vi.mock("../../src/main/codex-activity-monitor", () => ({
  // biome-ignore lint/complexity/useArrowFunction: class constructor mock
  CodexActivityMonitor: vi.fn().mockImplementation(function (callbacks) {
    const instance = {
      startMonitoring: vi.fn(),
      stopMonitoring: vi.fn(),
      callbacks,
      getState: () => activityMonitorSpies.state,
    };
    activityMonitorSpies.instances.push(instance);
    return instance;
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
  titleManager?: SessionTitleManager;
  title?: string;
}) {
  const { state, sessionsState } = createSessionsState();
  const manager =
    opts?.sessionLogFileManager || opts?.titleManager
      ? new CodexSessionsManager({
          state: sessionsState,
          sessionLogFileManager: opts.sessionLogFileManager,
          titleManager: opts.titleManager,
        })
      : new CodexSessionsManager(sessionsState);
  const sessionId = "session-codex-1";
  const startupConfig: CodexLocalTerminalSessionData["startupConfig"] = {
    cwd: "/tmp",
    modelReasoningEffort: "high",
    fastMode: "off",
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
    title: opts?.title ?? "Codex Session",
    codexSessionId: undefined,
    startupConfig,
    bufferedOutput: "",
  };

  return { manager, sessionId, state };
}

describe("CodexSessionsManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    terminalSessionSpies.status = "stopped";
    terminalSessionSpies.callbacks = [];
    terminalSessionSpies.bufferedOutput = "";
    activityMonitorSpies.instances = [];
    activityMonitorSpies.state = "unknown";
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
      fastMode: "off",
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
      fastMode: "off",
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

  it("stores codex session id from session_configured events", async () => {
    const sessionLogFileManager = {
      create: vi.fn(() => "/tmp/claude-state/codex-session-codex-1.jsonl"),
      cleanup: vi.fn(),
    } as unknown as CodexSessionLogFileManager;
    const { manager, sessionId, state } = createManager({
      initialPrompt: undefined,
      sessionLogFileManager,
    });

    manager.startLiveSession({
      sessionId,
      cwd: "/tmp",
      modelReasoningEffort: "high",
      fastMode: "off",
      permissionMode: "default",
      initialPrompt: undefined,
    });

    activityMonitorSpies.instances[0]?.callbacks.onLogEvent?.({
      ts: new Date().toISOString(),
      dir: "to_tui",
      kind: "codex_event",
      payload: {
        msg: {
          type: "session_configured",
          session_id: "019d0192-767b-7cc1-bdd9-9c8a13484557",
        },
      },
    });

    expect(state[sessionId]?.codexSessionId).toBe(
      "019d0192-767b-7cc1-bdd9-9c8a13484557",
    );
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
      fastMode: "off",
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
    expect(
      activityMonitorSpies.instances[0]?.startMonitoring,
    ).toHaveBeenCalledWith("/tmp/claude-state/codex-session-codex-1.jsonl");

    await manager.stopLiveSession(sessionId);
    expect(sessionLogFileManager.cleanup).toHaveBeenCalledWith(
      "/tmp/claude-state/codex-session-codex-1.jsonl",
    );
    expect(
      activityMonitorSpies.instances[0]?.stopMonitoring,
    ).toHaveBeenCalled();
  });

  it("does not defer-submit prompt when it is not /plan mode", async () => {
    const { manager, sessionId } = createManager();

    manager.startLiveSession({
      sessionId,
      cwd: "/tmp",
      modelReasoningEffort: "high",
      fastMode: "off",
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
      fastMode: "off",
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

  it("derives status from terminal + codex activity", async () => {
    const sessionLogFileManager = {
      create: vi.fn(() => "/tmp/claude-state/codex-session-codex-1.jsonl"),
      cleanup: vi.fn(),
    } as unknown as CodexSessionLogFileManager;
    const { manager, sessionId, state } = createManager({
      initialPrompt: undefined,
      sessionLogFileManager,
    });

    manager.startLiveSession({
      sessionId,
      cwd: "/tmp",
      modelReasoningEffort: "high",
      fastMode: "off",
      permissionMode: "default",
      initialPrompt: undefined,
    });
    const callbacks = terminalSessionSpies.callbacks[0];
    const session = state[sessionId];

    callbacks?.onStatusChange("starting");
    expect(session.status).toBe("starting");

    callbacks?.onStatusChange("running");
    expect(session.status).toBe("idle");

    activityMonitorSpies.instances[0]?.callbacks.onStatusChange("idle");
    expect(session.status).toBe("idle");

    activityMonitorSpies.instances[0]?.callbacks.onStatusChange("working");
    expect(session.status).toBe("running");

    activityMonitorSpies.instances[0]?.callbacks.onStatusChange(
      "awaiting_approval",
    );
    expect(session.status).toBe("awaiting_approval");

    activityMonitorSpies.instances[0]?.callbacks.onStatusChange(
      "awaiting_user_response",
    );
    expect(session.status).toBe("awaiting_user_response");

    callbacks?.onStatusChange("stopping");
    expect(session.status).toBe("stopping");

    callbacks?.onStatusChange("error");
    expect(session.status).toBe("error");

    callbacks?.onStatusChange("stopped");
    expect(session.status).toBe("stopped");
  });

  it("falls back to terminal-only status when log monitoring is unavailable", async () => {
    const { manager, sessionId, state } = createManager({
      initialPrompt: undefined,
    });

    manager.startLiveSession({
      sessionId,
      cwd: "/tmp",
      modelReasoningEffort: "high",
      fastMode: "off",
      permissionMode: "default",
      initialPrompt: undefined,
    });

    expect(activityMonitorSpies.instances).toHaveLength(0);
    const callbacks = terminalSessionSpies.callbacks[0];
    callbacks?.onStatusChange("running");
    expect(state[sessionId]?.status).toBe("idle");
  });

  it("uses codex resume when a persisted codex session id exists", async () => {
    const { manager, sessionId, state } = createManager({
      initialPrompt: "summarize recent commits",
    });
    state[sessionId].codexSessionId = "019d0192-767b-7cc1-bdd9-9c8a13484557";

    manager.startLiveSession({
      sessionId,
      codexSessionId: state[sessionId].codexSessionId,
      cwd: "/tmp",
      modelReasoningEffort: "high",
      fastMode: "off",
      permissionMode: "default",
      initialPrompt: undefined,
    } as Parameters<CodexSessionsManager["startLiveSession"]>[0]);

    const startCall = terminalSessionSpies.start.mock.calls.at(-1)?.[0] as
      | { args?: string[] }
      | undefined;
    expect(startCall?.args).toEqual([
      "resume",
      "019d0192-767b-7cc1-bdd9-9c8a13484557",
      "--no-alt-screen",
      "--model",
      "gpt-5.3-codex",
      "--disable",
      "fast_mode",
      "-c",
      "model_reasoning_effort=high",
    ]);
    expect(startCall?.args).not.toContain("'summarize recent commits'");
  });

  it("triggers title generation from the first submitted codex prompt", async () => {
    const titleManager = {
      maybeGenerate: vi.fn(),
      forget: vi.fn(),
    } as unknown as SessionTitleManager;
    const sessionLogFileManager = {
      create: vi.fn(() => "/tmp/claude-state/codex-session-codex-1.jsonl"),
      cleanup: vi.fn(),
    } as unknown as CodexSessionLogFileManager;
    const { manager, sessionId, state } = createManager({
      initialPrompt: undefined,
      sessionLogFileManager,
      titleManager,
    });

    vi.mocked(titleManager.maybeGenerate).mockImplementation((params) => {
      params.onTitleReady("Generated from log");
    });

    manager.startLiveSession({
      sessionId,
      cwd: "/tmp",
      modelReasoningEffort: "high",
      fastMode: "off",
      permissionMode: "default",
      initialPrompt: undefined,
    });

    activityMonitorSpies.instances[0]?.callbacks.onLogEvent?.({
      ts: new Date().toISOString(),
      dir: "to_tui",
      kind: "codex_event",
      payload: {
        msg: {
          type: "user_message",
          message: "  /plan   add codex title generation from logs  ",
        },
      },
    });

    expect(titleManager.maybeGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        prompt: "add codex title generation from logs",
      }),
    );
    expect(state[sessionId]?.title).toBe("Generated from log");
  });

  it("does not trigger title generation from log prompts when title is already custom", async () => {
    const titleManager = {
      maybeGenerate: vi.fn(),
      forget: vi.fn(),
    } as unknown as SessionTitleManager;
    const sessionLogFileManager = {
      create: vi.fn(() => "/tmp/claude-state/codex-session-codex-1.jsonl"),
      cleanup: vi.fn(),
    } as unknown as CodexSessionLogFileManager;
    const { manager, sessionId } = createManager({
      initialPrompt: undefined,
      sessionLogFileManager,
      titleManager,
      title: "Already named",
    });

    manager.startLiveSession({
      sessionId,
      cwd: "/tmp",
      modelReasoningEffort: "high",
      fastMode: "off",
      permissionMode: "default",
      initialPrompt: undefined,
    });

    activityMonitorSpies.instances[0]?.callbacks.onLogEvent?.({
      ts: new Date().toISOString(),
      dir: "to_tui",
      kind: "codex_event",
      payload: {
        msg: {
          type: "user_message",
          message: "rename me",
        },
      },
    });

    expect(titleManager.maybeGenerate).not.toHaveBeenCalled();
  });

  it("does not change status on output events", async () => {
    const { manager, sessionId, state } = createManager({
      initialPrompt: undefined,
    });

    manager.startLiveSession({
      sessionId,
      cwd: "/tmp",
      modelReasoningEffort: "high",
      fastMode: "off",
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
      fastMode: "off",
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
        fastMode: "off",
        permissionMode: "default",
        initialPrompt: undefined,
      });
    }

    await manager.dispose();

    expect(terminalSessionSpies.stop).toHaveBeenCalledTimes(2);
    expect(manager.liveSessions.size).toBe(0);
  });

  it("passes fast mode through to the codex process args", async () => {
    const { manager, sessionId } = createManager({
      initialPrompt: undefined,
    });

    manager.startLiveSession({
      sessionId,
      cwd: "/tmp",
      modelReasoningEffort: "high",
      fastMode: "fast",
      permissionMode: "default",
      initialPrompt: undefined,
    });

    const startCall = terminalSessionSpies.start.mock.calls.at(-1)?.[0] as
      | { args?: string[] }
      | undefined;
    expect(startCall?.args).toContain("--enable");
    expect(startCall?.args).toContain("fast_mode");
    expect(startCall?.args).toContain("service_tier=fast");

    await manager.stopLiveSession(sessionId);
  });
});
