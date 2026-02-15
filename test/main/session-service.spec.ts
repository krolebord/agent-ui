import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistenceOrchestrator } from "../../src/main/persistence-orchestrator";
import { SessionsServiceNew } from "../../src/main/session-service";
import type { SessionStateFileManager } from "../../src/main/session-state-file-manager";
import type { SessionTitleManager } from "../../src/main/session-title-manager";

const terminalSessionSpies = vi.hoisted(() => {
  return {
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    write: vi.fn(),
    resize: vi.fn(),
    clear: vi.fn(),
    callbacks: [] as Array<{
      onStatusChange: (status: string) => void;
      onData: (chunk: string) => void;
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
    callbacks: [] as Array<{
      onStatusChange: (status: string) => void;
      onHookEvent: (event: { hook_event_name: string; prompt?: string }) => void;
    }>,
  };
});

vi.mock("../../src/main/terminal-session", () => ({
  createTerminalSession: vi.fn().mockImplementation((callbacks) => {
    terminalSessionSpies.callbacks.push(callbacks);
    return terminalSessionSpies;
  }),
}));

vi.mock("../../src/main/claude-activity-monitor", () => ({
  ClaudeActivityMonitor: vi.fn().mockImplementation((callbacks) => {
    activityMonitorSpies.callbacks.push(callbacks);

    return {
      startMonitoring: activityMonitorSpies.startMonitoring,
      stopMonitoring: activityMonitorSpies.stopMonitoring,
    };
  }),
}));

function createService() {
  const persistence = {
    registerAndHydrate: vi.fn(),
  };
  const titleManager = {
    forget: vi.fn(),
    maybeGenerate: vi.fn(),
  };
  const stateFileManager = {
    create: vi.fn().mockResolvedValue("/tmp/test-state.ndjson"),
    cleanup: vi.fn(),
  };

  const service = new SessionsServiceNew({
    persistence: persistence as unknown as PersistenceOrchestrator,
    pluginDir: null,
    pluginWarning: null,
    titleManager: titleManager as unknown as SessionTitleManager,
    stateFileManager: stateFileManager as unknown as SessionStateFileManager,
  });

  return { service, persistence, titleManager, stateFileManager };
}

describe("SessionsServiceNew", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activityMonitorSpies.callbacks = [];
    terminalSessionSpies.callbacks = [];
  });

  describe("startNewSession", () => {
    it("uses sessionName as title when provided", async () => {
      const { service, stateFileManager } = createService();

      const sessionId = await service.startNewSession({
        cwd: "/tmp",
        cols: 120,
        rows: 30,
        sessionName: "  Planning Session  ",
      });

      const session = service.getSessionById(sessionId);

      expect(session?.title).toBe("Planning Session");
      expect(stateFileManager.create).toHaveBeenCalledWith(sessionId);
      expect(terminalSessionSpies.start).toHaveBeenCalledTimes(1);
    });

    it("falls back to generated title when sessionName is blank", async () => {
      const { service } = createService();

      const sessionId = await service.startNewSession({
        cwd: "/tmp",
        cols: 120,
        rows: 30,
        sessionName: "   ",
      });

      const session = service.getSessionById(sessionId);

      expect(session?.title).toMatch(/^Session [0-9a-f]{8}$/i);
    });

    it("creates state file before spawn and passes it via environment", async () => {
      const { service, stateFileManager } = createService();

      await service.startNewSession({
        cwd: "/tmp",
        cols: 120,
        rows: 30,
      });

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
      const { service } = createService();

      const sessionId = await service.startNewSession({
        cwd: "/tmp",
        cols: 120,
        rows: 30,
      });

      const callbacks = terminalSessionSpies.callbacks[0];
      callbacks?.onStatusChange("stopping");

      expect(service.getSessionById(sessionId)?.terminal.status).toBe(
        "stopping",
      );
    });

    it("triggers title generation from first prompt submit for unnamed sessions", async () => {
      const { service, titleManager } = createService();

      vi.mocked(titleManager.maybeGenerate).mockImplementation((params) => {
        params.onTitleReady("Generated from prompt");
      });

      const sessionId = await service.startNewSession({
        cwd: "/tmp",
        cols: 120,
        rows: 30,
      });

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
      expect(service.getSessionById(sessionId)?.title).toBe(
        "Generated from prompt",
      );
    });

    it("does not trigger title generation for named sessions", async () => {
      const { service, titleManager } = createService();

      await service.startNewSession({
        cwd: "/tmp",
        cols: 120,
        rows: 30,
        sessionName: "Planned Name",
      });

      const callbacks = activityMonitorSpies.callbacks[0];
      callbacks?.onHookEvent({
        hook_event_name: "UserPromptSubmit",
        prompt: "Summarize status",
      });

      expect(titleManager.maybeGenerate).not.toHaveBeenCalled();
    });

    it("does not retain a live session when terminal exits during start", async () => {
      const { service, stateFileManager, titleManager } = createService();

      terminalSessionSpies.start.mockImplementationOnce(() => {
        const callbacks = terminalSessionSpies.callbacks.at(-1);
        callbacks?.onExit({
          exitCode: 1,
          errorMessage: "start failed",
        });
      });

      const sessionId = await service.startNewSession({
        cwd: "/tmp",
        cols: 120,
        rows: 30,
      });

      await vi.waitFor(() => {
        expect(service.getLiveSession(sessionId)).toBeNull();
      });
      expect(stateFileManager.cleanup).toHaveBeenCalledWith(
        "/tmp/test-state.ndjson",
      );
      expect(titleManager.forget).toHaveBeenCalledWith(sessionId);
      expect(service.getSessionById(sessionId)?.terminal.status).toBe("error");
    });
  });

  describe("stopLiveSession", () => {
    it("cleans up the created state file path", async () => {
      const { service, stateFileManager, titleManager } = createService();

      const sessionId = await service.startNewSession({
        cwd: "/tmp",
        cols: 120,
        rows: 30,
      });

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

      const firstSessionId = await service.startNewSession({
        cwd: "/tmp",
        cols: 120,
        rows: 30,
      });
      const secondSessionId = await service.startNewSession({
        cwd: "/tmp",
        cols: 120,
        rows: 30,
      });

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
      const { service, stateFileManager } = createService();

      const sourceSessionId = await service.startNewSession({
        cwd: "/tmp",
        cols: 120,
        rows: 30,
        sessionName: "Source Session",
      });

      const forkedSessionId = await service.forkSession({
        sessionId: sourceSessionId,
        cols: 100,
        rows: 25,
      });

      expect(forkedSessionId).not.toBe(sourceSessionId);
      expect(service.getSessionById(forkedSessionId)).toMatchObject({
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
