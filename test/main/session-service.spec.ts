import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ClaudeLocalTerminalSessionData,
  SessionsServiceNew,
} from "../../src/main/session-service";
import type { SessionStateFileManager } from "../../src/main/session-state-file-manager";
import type { SessionTitleManager } from "../../src/main/session-title-manager";
import type { SessionServiceState } from "../../src/main/sessions/state";

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
    startMonitoring: vi.fn(),
    stopMonitoring: vi.fn(),
    state: "idle" as
      | "idle"
      | "awaiting_approval"
      | "awaiting_user_response"
      | "working",
    callbacks: [] as Array<{
      onStatusChange: (status: string) => void;
      onHookEvent: (event: {
        hook_event_name: string;
        prompt?: string;
      }) => void;
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
    return terminalSessionSpies;
  }),
}));

vi.mock("../../src/main/claude-activity-monitor", () => ({
  // biome-ignore lint/complexity/useArrowFunction: must be a regular function — called with `new` and arrow functions aren't constructable
  ClaudeActivityMonitor: vi.fn().mockImplementation(function (callbacks) {
    activityMonitorSpies.callbacks.push({
      ...callbacks,
      onStatusChange: (status: string) => {
        activityMonitorSpies.state =
          status as typeof activityMonitorSpies.state;
        callbacks.onStatusChange(status);
      },
    });

    return {
      startMonitoring: activityMonitorSpies.startMonitoring,
      stopMonitoring: activityMonitorSpies.stopMonitoring,
      getState: () => activityMonitorSpies.state,
    };
  }),
}));

function createService() {
  const state: Record<string, ClaudeLocalTerminalSessionData> = {};
  const sessionsState = {
    state,
    updateState: (updater: (draft: typeof state) => void) => {
      updater(state);
    },
  } as unknown as SessionServiceState;

  const titleManager = {
    forget: vi.fn(),
    maybeGenerate: vi.fn(),
  };
  const stateFileManager = {
    create: vi.fn().mockResolvedValue("/tmp/test-state.ndjson"),
    cleanup: vi.fn(),
  };

  const service = new SessionsServiceNew({
    pluginDir: null,
    pluginWarning: null,
    titleManager: titleManager as unknown as SessionTitleManager,
    stateFileManager: stateFileManager as unknown as SessionStateFileManager,
    state: sessionsState,
  });

  return { service, state, titleManager, stateFileManager };
}

type StartNewSessionInput = Parameters<
  SessionsServiceNew["startNewSession"]
>[0];

function makeStartInput(
  overrides: Partial<StartNewSessionInput> = {},
): StartNewSessionInput {
  return {
    cwd: "/tmp",
    cols: 120,
    rows: 30,
    sessionName: undefined,
    initialPrompt: undefined,
    ...overrides,
  };
}

describe("SessionsServiceNew", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalSessionSpies.status = "stopped";
    terminalSessionSpies.bufferedOutput = "";
    activityMonitorSpies.state = "idle";
    activityMonitorSpies.callbacks = [];
    terminalSessionSpies.callbacks = [];
  });

  describe("startNewSession", () => {
    it("uses sessionName as title when provided", async () => {
      const { service, state, stateFileManager } = createService();

      const sessionId = await service.startNewSession(
        makeStartInput({
          sessionName: "  Planning Session  ",
        }),
      );

      const session = state[sessionId];

      expect(session?.title).toBe("Planning Session");
      expect(stateFileManager.create).toHaveBeenCalledWith(sessionId);
      expect(terminalSessionSpies.start).toHaveBeenCalledTimes(1);
    });

    it("falls back to generated title when sessionName is blank", async () => {
      const { service, state } = createService();

      const sessionId = await service.startNewSession(
        makeStartInput({
          sessionName: "   ",
        }),
      );

      const session = state[sessionId];

      expect(session?.title).toMatch(/^Session [0-9a-f]{8}$/i);
    });

    it("creates state file before spawn and passes it via environment", async () => {
      const { service, stateFileManager } = createService();

      await service.startNewSession(makeStartInput());

      expect(stateFileManager.create).toHaveBeenCalledTimes(1);
      expect(activityMonitorSpies.startMonitoring).toHaveBeenCalledWith(
        "/tmp/test-state.ndjson",
      );

      expect(terminalSessionSpies.start).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            CLAUDE_UI_STATE_FILE: "/tmp/test-state.ndjson",
          }),
        }),
      );

      const createOrder = stateFileManager.create.mock.invocationCallOrder[0];
      const startOrder = terminalSessionSpies.start.mock.invocationCallOrder[0];

      expect(createOrder).toBeLessThan(startOrder);
    });

    it("updates persisted status when terminal reports stopping", async () => {
      const { service, state } = createService();

      const sessionId = await service.startNewSession(makeStartInput());

      const callbacks = terminalSessionSpies.callbacks[0];
      callbacks?.onStatusChange("stopping");

      expect(state[sessionId]?.status).toBe("stopping");
    });

    it("triggers title generation from first prompt submit for unnamed sessions", async () => {
      const { service, state, titleManager } = createService();

      vi.mocked(titleManager.maybeGenerate).mockImplementation((params) => {
        params.onTitleReady("Generated from prompt");
      });

      const sessionId = await service.startNewSession(makeStartInput());

      const callbacks = activityMonitorSpies.callbacks[0];
      callbacks?.onHookEvent({
        hook_event_name: "UserPromptSubmit",
        prompt: "  Draft release notes  ",
      });

      expect(titleManager.maybeGenerate).toHaveBeenCalledTimes(1);
      expect(titleManager.maybeGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          prompt: "Draft release notes",
        }),
      );
      expect(state[sessionId]?.title).toBe("Generated from prompt");
    });

    it("does not trigger title generation for named sessions", async () => {
      const { service, titleManager } = createService();

      await service.startNewSession(
        makeStartInput({
          sessionName: "Planned Name",
        }),
      );

      const callbacks = activityMonitorSpies.callbacks[0];
      callbacks?.onHookEvent({
        hook_event_name: "UserPromptSubmit",
        prompt: "Summarize status",
      });

      expect(titleManager.maybeGenerate).not.toHaveBeenCalled();
    });

    it("does not retain a live session when terminal exits during start", async () => {
      const { service, state, stateFileManager, titleManager } =
        createService();

      terminalSessionSpies.start.mockImplementationOnce(() => {
        const callbacks = terminalSessionSpies.callbacks.at(-1);
        callbacks?.onExit({
          exitCode: 1,
          errorMessage: "start failed",
        });
      });

      const sessionId = await service.startNewSession(makeStartInput());

      await vi.waitFor(() => {
        expect(service.getLiveSession(sessionId)).toBeNull();
      });
      expect(stateFileManager.cleanup).toHaveBeenCalledWith(
        "/tmp/test-state.ndjson",
      );
      expect(titleManager.forget).toHaveBeenCalledWith(sessionId);
      expect(state[sessionId]?.status).toBe("error");
    });
  });

  describe("stopLiveSession", () => {
    it("cleans up the created state file path", async () => {
      const { service, stateFileManager, titleManager } = createService();

      const sessionId = await service.startNewSession(makeStartInput());

      await service.stopLiveSession(sessionId);

      expect(stateFileManager.cleanup).toHaveBeenCalledWith(
        "/tmp/test-state.ndjson",
      );
      expect(stateFileManager.cleanup).not.toHaveBeenCalledWith(sessionId);
      expect(activityMonitorSpies.stopMonitoring).toHaveBeenCalledTimes(1);
      expect(terminalSessionSpies.stop).toHaveBeenCalledTimes(1);
      expect(titleManager.forget).toHaveBeenCalledWith(sessionId);
    });
  });

  describe("dispose", () => {
    it("stops and cleans up all live sessions", async () => {
      const { service, stateFileManager, titleManager } = createService();

      const firstSessionId = await service.startNewSession(makeStartInput());
      const secondSessionId = await service.startNewSession(makeStartInput());

      await service.dispose();

      expect(terminalSessionSpies.stop).toHaveBeenCalledTimes(2);
      expect(activityMonitorSpies.stopMonitoring).toHaveBeenCalledTimes(2);
      expect(stateFileManager.cleanup).toHaveBeenCalledTimes(2);
      expect(titleManager.forget).toHaveBeenCalledWith(firstSessionId);
      expect(titleManager.forget).toHaveBeenCalledWith(secondSessionId);
      expect(service.getLiveSession(firstSessionId)).toBeNull();
      expect(service.getLiveSession(secondSessionId)).toBeNull();
    });
  });

  describe("forkSession", () => {
    it("creates and starts a forked session under the new session ID", async () => {
      const { service, state, stateFileManager } = createService();

      const sourceSessionId = await service.startNewSession(
        makeStartInput({
          sessionName: "Source Session",
        }),
      );

      const forkedSessionId = await service.forkSession({
        sessionId: sourceSessionId,
        cols: 100,
        rows: 25,
      });

      expect(forkedSessionId).not.toBe(sourceSessionId);
      expect(state[forkedSessionId]).toMatchObject({
        sessionId: forkedSessionId,
        title: "Source Session (fork)",
      });

      expect(service.getLiveSession(sourceSessionId)).not.toBeNull();
      expect(service.getLiveSession(forkedSessionId)).not.toBeNull();

      expect(stateFileManager.create).toHaveBeenCalledWith(sourceSessionId);
      expect(stateFileManager.create).toHaveBeenCalledWith(forkedSessionId);
    });
  });
});
