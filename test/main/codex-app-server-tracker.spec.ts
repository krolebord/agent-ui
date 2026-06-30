import { describe, expect, it, vi } from "vitest";
import {
  type CodexAppServerSessionState,
  type CodexAppServerSubagentUpdate,
  CodexAppServerTracker,
} from "../../src/main/codex-app-server-tracker";

type TrackerHarness = {
  handleNotification: (message: {
    method: string;
    params?: Record<string, unknown>;
  }) => void;
};

function createTracker(options?: { initialThreadId?: string }) {
  const onStatusChange = vi.fn<(status: CodexAppServerSessionState) => void>();
  const onThreadId = vi.fn<(threadId: string) => void>();
  const onSubagentUpdate =
    vi.fn<(update: CodexAppServerSubagentUpdate) => void>();

  const tracker = new CodexAppServerTracker({
    sessionId: "session-1",
    wsUrl: "ws://127.0.0.1:34567",
    initialThreadId: options?.initialThreadId,
    onStatusChange,
    onThreadId,
    onSubagentUpdate,
  });

  return { tracker, onStatusChange, onThreadId, onSubagentUpdate };
}

function asHarness(tracker: CodexAppServerTracker): TrackerHarness {
  return tracker as unknown as TrackerHarness;
}

describe("CodexAppServerTracker mappings", () => {
  it("maps waitingOnApproval to awaiting_approval", () => {
    const { tracker, onStatusChange, onThreadId } = createTracker();

    asHarness(tracker).handleNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: {
          type: "active",
          activeFlags: ["waitingOnApproval"],
        },
      },
    });

    expect(onThreadId).toHaveBeenCalledWith("thread-1");
    expect(onStatusChange).toHaveBeenCalledWith("awaiting_approval");
  });

  it("maps waitingOnUserInput to awaiting_approval", () => {
    const { tracker, onStatusChange } = createTracker();

    asHarness(tracker).handleNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: {
          type: "active",
          activeFlags: ["waitingOnUserInput"],
        },
      },
    });

    expect(onStatusChange).toHaveBeenCalledWith("awaiting_approval");
  });

  it("maps fresh idle threads to awaiting_user_response", () => {
    const { tracker, onStatusChange } = createTracker();

    asHarness(tracker).handleNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: {
          type: "idle",
        },
      },
    });

    expect(onStatusChange).toHaveBeenCalledWith("awaiting_user_response");
  });

  it("maps completed turns to awaiting_user_response", () => {
    const { tracker, onStatusChange } = createTracker();

    asHarness(tracker).handleNotification({
      method: "turn/started",
      params: {
        threadId: "thread-1",
      },
    });
    asHarness(tracker).handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          status: "completed",
        },
      },
    });

    expect(onStatusChange).toHaveBeenNthCalledWith(1, "running");
    expect(onStatusChange).toHaveBeenNthCalledWith(2, "awaiting_user_response");
  });

  it("maps failed turns to error", () => {
    const { tracker, onStatusChange } = createTracker();

    asHarness(tracker).handleNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          status: "failed",
        },
      },
    });

    expect(onStatusChange).toHaveBeenCalledWith("error");
  });

  it("tracks subagent thread status without replacing the root status", () => {
    const { tracker, onStatusChange, onThreadId, onSubagentUpdate } =
      createTracker();

    asHarness(tracker).handleNotification({
      method: "thread/started",
      params: {
        thread: {
          id: "root-thread",
          parentThreadId: null,
        },
      },
    });
    asHarness(tracker).handleNotification({
      method: "thread/status/changed",
      params: {
        threadId: "root-thread",
        status: {
          type: "active",
          activeFlags: [],
        },
      },
    });
    asHarness(tracker).handleNotification({
      method: "thread/status/changed",
      params: {
        threadId: "child-thread",
        status: {
          type: "active",
          activeFlags: [],
        },
      },
    });

    expect(onThreadId).toHaveBeenCalledTimes(1);
    expect(onThreadId).toHaveBeenCalledWith("root-thread");
    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenCalledWith("running");
    expect(onSubagentUpdate).toHaveBeenCalledWith({
      threadId: "child-thread",
      status: "running",
    });
  });

  it("discovers subagents from completed collab spawn items", () => {
    const { tracker, onSubagentUpdate } = createTracker({
      initialThreadId: "root-thread",
    });

    asHarness(tracker).handleNotification({
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          senderThreadId: "root-thread",
          receiverThreadIds: ["child-thread"],
          prompt: "Inspect package.json and report findings",
          agentsStates: {
            "child-thread": {
              status: "pendingInit",
              message: null,
            },
          },
        },
      },
    });

    expect(onSubagentUpdate).toHaveBeenCalledWith({
      threadId: "child-thread",
      parentThreadId: "root-thread",
      initialPrompt: "Inspect package.json and report findings",
      collabStatus: "pendingInit",
      status: "starting",
    });
  });
});
