import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTitleManager } from "../../src/main/session-title-manager";
import {
  type CodexLocalTerminalSessionData,
  CodexSessionsManager,
} from "../../src/main/sessions/codex.session";
import type { SessionServiceState } from "../../src/main/sessions/state";

type TrackerState =
  | "idle"
  | "running"
  | "awaiting_approval"
  | "awaiting_user_response"
  | "error";

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

const appServerSpies = vi.hoisted(() => {
  return {
    instances: [] as Array<{
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      wsUrl: string;
      onUnexpectedExit?: (payload: {
        exitCode: number | null;
        signal?: NodeJS.Signals;
      }) => void;
    }>,
  };
});

const trackerSpies = vi.hoisted(() => {
  return {
    instances: [] as Array<{
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      callbacks: {
        onThreadId?: (threadId: string) => void;
        onStatusChange?: (status: TrackerState) => void;
        onTitleUpdated?: (title: string) => void;
        onError?: (errorMessage: string) => void;
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

vi.mock("../../src/main/codex-app-server-runtime", () => ({
  // biome-ignore lint/complexity/useArrowFunction: class constructor mock
  CodexAppServerProcess: vi.fn().mockImplementation(function (options) {
    const instance = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      wsUrl: "ws://127.0.0.1:34567",
      onUnexpectedExit: options.onUnexpectedExit,
    };
    appServerSpies.instances.push(instance);
    return instance;
  }),
}));

vi.mock("../../src/main/codex-app-server-tracker", () => ({
  // biome-ignore lint/complexity/useArrowFunction: class constructor mock
  CodexAppServerTracker: vi.fn().mockImplementation(function (options) {
    const instance = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      callbacks: {
        onThreadId: options.onThreadId,
        onStatusChange: options.onStatusChange,
        onTitleUpdated: options.onTitleUpdated,
        onError: options.onError,
      },
    };
    trackerSpies.instances.push(instance);
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
  titleManager?: SessionTitleManager;
  title?: string;
}) {
  const { state, sessionsState } = createSessionsState();
  const manager = opts?.titleManager
    ? new CodexSessionsManager({
        state: sessionsState,
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
    appServerSpies.instances = [];
    trackerSpies.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("submits deferred /plan prompt after switching to running", async () => {
    const { manager, sessionId } = createManager();

    await manager.startLiveSession({
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

  it("starts codex against the per-session app-server", async () => {
    const { manager, sessionId } = createManager({
      initialPrompt: undefined,
    });

    await manager.startLiveSession({
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
    expect(appServerSpies.instances[0]?.start).toHaveBeenCalled();
    expect(trackerSpies.instances[0]?.start).toHaveBeenCalled();
    expect(startCall?.args).toEqual([
      "--remote",
      "ws://127.0.0.1:34567",
      "--no-alt-screen",
      "--disable apps",
      "--model",
      "gpt-5.3-codex",
      "--disable",
      "fast_mode",
      "-c",
      "model_reasoning_effort=high",
    ]);
    expect(startCall?.env).toBeUndefined();

    await manager.stopLiveSession(sessionId);
  });

  it("stores thread id reported by the tracker", async () => {
    const { manager, sessionId, state } = createManager({
      initialPrompt: undefined,
    });

    await manager.startLiveSession({
      sessionId,
      cwd: "/tmp",
      modelReasoningEffort: "high",
      fastMode: "off",
      permissionMode: "default",
      initialPrompt: undefined,
    });

    trackerSpies.instances[0]?.callbacks.onThreadId?.(
      "019d0192-767b-7cc1-bdd9-9c8a13484557",
    );

    expect(state[sessionId]?.codexSessionId).toBe(
      "019d0192-767b-7cc1-bdd9-9c8a13484557",
    );
  });

  it("does not defer-submit prompt when it is not /plan mode", async () => {
    const { manager, sessionId } = createManager();

    await manager.startLiveSession({
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

    await manager.startLiveSession({
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

    await manager.stopLiveSession(sessionId);
  });

  it("derives status from terminal + tracker state", async () => {
    const { manager, sessionId, state } = createManager({
      initialPrompt: undefined,
    });

    await manager.startLiveSession({
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

    trackerSpies.instances[0]?.callbacks.onStatusChange?.("idle");
    expect(session.status).toBe("idle");

    trackerSpies.instances[0]?.callbacks.onStatusChange?.("running");
    expect(session.status).toBe("running");

    trackerSpies.instances[0]?.callbacks.onStatusChange?.("awaiting_approval");
    expect(session.status).toBe("awaiting_approval");

    trackerSpies.instances[0]?.callbacks.onStatusChange?.(
      "awaiting_user_response",
    );
    expect(session.status).toBe("awaiting_user_response");

    trackerSpies.instances[0]?.callbacks.onStatusChange?.("error");
    expect(session.status).toBe("error");

    callbacks?.onStatusChange("stopping");
    expect(session.status).toBe("stopping");

    callbacks?.onStatusChange("stopped");
    expect(session.status).toBe("stopped");
  });

  it("uses codex resume when a persisted thread id exists", async () => {
    const { manager, sessionId, state } = createManager({
      initialPrompt: "summarize recent commits",
    });
    state[sessionId].codexSessionId = "019d0192-767b-7cc1-bdd9-9c8a13484557";

    await manager.startLiveSession({
      sessionId,
      codexSessionId: state[sessionId].codexSessionId,
      cwd: "/tmp",
      modelReasoningEffort: "high",
      fastMode: "off",
      permissionMode: "default",
      initialPrompt: undefined,
    });

    const startCall = terminalSessionSpies.start.mock.calls.at(-1)?.[0] as
      | { args?: string[] }
      | undefined;
    expect(startCall?.args).toEqual([
      "--remote",
      "ws://127.0.0.1:34567",
      "resume",
      "019d0192-767b-7cc1-bdd9-9c8a13484557",
      "--no-alt-screen",
      "--disable apps",
      "--model",
      "gpt-5.3-codex",
      "--disable",
      "fast_mode",
      "-c",
      "model_reasoning_effort=high",
    ]);
    expect(startCall?.args).not.toContain("'summarize recent commits'");
  });

  it("updates the default title from tracker notifications", async () => {
    const { manager, sessionId, state } = createManager({
      initialPrompt: undefined,
    });

    await manager.startLiveSession({
      sessionId,
      cwd: "/tmp",
      modelReasoningEffort: "high",
      fastMode: "off",
      permissionMode: "default",
      initialPrompt: undefined,
    });

    trackerSpies.instances[0]?.callbacks.onTitleUpdated?.("Generated title");

    expect(state[sessionId]?.title).toBe("Generated title");
  });

  it("does not overwrite a custom title from tracker notifications", async () => {
    const { manager, sessionId, state } = createManager({
      initialPrompt: undefined,
      title: "Already named",
    });

    await manager.startLiveSession({
      sessionId,
      cwd: "/tmp",
      modelReasoningEffort: "high",
      fastMode: "off",
      permissionMode: "default",
      initialPrompt: undefined,
    });

    trackerSpies.instances[0]?.callbacks.onTitleUpdated?.("Generated title");

    expect(state[sessionId]?.title).toBe("Already named");
  });

  it("does not change status on output events", async () => {
    const { manager, sessionId, state } = createManager({
      initialPrompt: undefined,
    });

    await manager.startLiveSession({
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
    trackerSpies.instances[0]?.callbacks.onStatusChange?.("running");
    expect(session.status).toBe("running");

    callbacks?.onData({ chunk: "still working...", bufferedOutput: "..." });
    expect(session.status).toBe("running");
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
      await manager.startLiveSession({
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
    expect(appServerSpies.instances[0]?.stop).toHaveBeenCalled();
    expect(appServerSpies.instances[1]?.stop).toHaveBeenCalled();
    expect(trackerSpies.instances[0]?.stop).toHaveBeenCalled();
    expect(trackerSpies.instances[1]?.stop).toHaveBeenCalled();
    expect(manager.liveSessions.size).toBe(0);
  });

  it("passes fast mode through to the codex process args", async () => {
    const { manager, sessionId } = createManager({
      initialPrompt: undefined,
    });

    await manager.startLiveSession({
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

  it("creates and starts a forked session under a new local session ID", async () => {
    const { state, sessionsState } = createSessionsState();
    const manager = new CodexSessionsManager(sessionsState);

    state["source-session"] = {
      sessionId: "source-session",
      type: "codex-local-terminal",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "stopped",
      title: "Source Session",
      codexSessionId: "codex-session-1",
      startupConfig: {
        cwd: "/tmp/project",
        model: "gpt-5.3-codex",
        modelReasoningEffort: "minimal",
        fastMode: "fast",
        permissionMode: "yolo",
        initialPrompt: "summarize status",
        configOverrides: 'model_provider = "openai"',
      },
      bufferedOutput: "existing output",
    };

    const result = await manager.forkSession({
      sessionId: "source-session",
      cols: 100,
      rows: 30,
    });

    expect(result.sessionId).not.toBe("source-session");
    expect(state[result.sessionId]).toMatchObject({
      sessionId: result.sessionId,
      type: "codex-local-terminal",
      title: "Source Session (fork)",
      codexSessionId: undefined,
      startupConfig: {
        cwd: "/tmp/project",
        model: "gpt-5.3-codex",
        modelReasoningEffort: "minimal",
        fastMode: "fast",
        permissionMode: "yolo",
        initialPrompt: "summarize status",
        configOverrides: 'model_provider = "openai"',
      },
    });

    const startCall = terminalSessionSpies.start.mock.calls.at(-1)?.[0] as
      | { args?: string[]; cols?: number; rows?: number; cwd?: string }
      | undefined;
    expect(startCall).toMatchObject({
      cwd: "/tmp/project",
      cols: 100,
      rows: 30,
    });
    expect(startCall?.args).toEqual([
      "--remote",
      "ws://127.0.0.1:34567",
      "fork",
      "codex-session-1",
      "--no-alt-screen",
      "--disable apps",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "gpt-5.3-codex",
      "--enable",
      "fast_mode",
      "-c",
      "model_reasoning_effort=minimal",
      "-c",
      "service_tier=fast",
      "--config",
      'model_provider = "openai"',
    ]);
    expect(manager.liveSessions.has(result.sessionId)).toBe(true);
  });

  it("rejects when the source session does not exist", async () => {
    const { sessionsState } = createSessionsState();
    const manager = new CodexSessionsManager(sessionsState);

    await expect(
      manager.forkSession({
        sessionId: "missing-session",
      }),
    ).rejects.toThrow("Session missing-session not found");
  });

  it("rejects when the source session has no codex session id yet", async () => {
    const { state, sessionsState } = createSessionsState();
    const manager = new CodexSessionsManager(sessionsState);

    state["source-session"] = {
      sessionId: "source-session",
      type: "codex-local-terminal",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "stopped",
      title: "Source Session",
      codexSessionId: undefined,
      startupConfig: {
        cwd: "/tmp/project",
        model: "gpt-5.3-codex",
        modelReasoningEffort: "high",
        fastMode: "default",
        permissionMode: "default",
        initialPrompt: undefined,
        configOverrides: undefined,
      },
      bufferedOutput: "",
    };

    await expect(
      manager.forkSession({
        sessionId: "source-session",
      }),
    ).rejects.toThrow("Codex session is not ready to fork yet.");
  });
});
