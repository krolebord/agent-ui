import { describe, expect, it, vi } from "vitest";
import {
  type CodexAppServerSessionState,
  type CodexAppServerSubagentUpdate,
  CodexAppServerTracker,
  type CodexExternalAuthTokens,
} from "../../src/main/codex-app-server-tracker";

vi.mock("../../src/main/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type TrackerHarness = {
  handleNotification: (message: {
    method: string;
    params?: Record<string, unknown>;
  }) => void;
  handleMessage: (rawMessage: string) => void;
  ws: unknown;
};

function createTracker(options?: {
  initialThreadId?: string;
  onChatgptAuthTokensRefresh?: () => Promise<CodexExternalAuthTokens>;
}) {
  const onStatusChange = vi.fn<(status: CodexAppServerSessionState) => void>();
  const onThreadId = vi.fn<(threadId: string) => void>();
  const onTurnCompleted =
    vi.fn<(threadId: string, outcome: "completed" | "interrupted") => void>();
  const onSubagentUpdate =
    vi.fn<(update: CodexAppServerSubagentUpdate) => void>();

  const tracker = new CodexAppServerTracker({
    sessionId: "session-1",
    wsUrl: "ws://127.0.0.1:34567",
    initialThreadId: options?.initialThreadId,
    onStatusChange,
    onThreadId,
    onTurnCompleted,
    onSubagentUpdate,
    onChatgptAuthTokensRefresh: options?.onChatgptAuthTokensRefresh,
  });

  return {
    tracker,
    onStatusChange,
    onThreadId,
    onSubagentUpdate,
    onTurnCompleted,
  };
}

function asHarness(tracker: CodexAppServerTracker): TrackerHarness {
  return tracker as unknown as TrackerHarness;
}

function attachFakeSocket(tracker: CodexAppServerTracker) {
  const send = vi.fn<(data: string) => void>();
  asHarness(tracker).ws = { send };
  return {
    send,
    sent: () =>
      send.mock.calls.map(
        ([data]) => JSON.parse(data) as Record<string, unknown>,
      ),
    receive: (message: unknown) =>
      asHarness(tracker).handleMessage(JSON.stringify(message)),
  };
}

describe("CodexAppServerTracker mappings", () => {
  it.each(["completed", "interrupted", "failed"])(
    "reports the actual outcome of a %s turn",
    (status) => {
      const { tracker, onTurnCompleted } = createTracker();
      asHarness(tracker).handleNotification({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { status } },
      });
      expect(onTurnCompleted).toHaveBeenCalledWith(
        "thread-1",
        status === "completed" ? "completed" : "interrupted",
      );
    },
  );

  it("does not report successful completion from a thread merely becoming idle", () => {
    const { tracker, onTurnCompleted } = createTracker();
    asHarness(tracker).handleNotification({
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "idle" } },
    });
    expect(onTurnCompleted).not.toHaveBeenCalled();
  });
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

describe("CodexAppServerTracker async questions", () => {
  function createQuestionTracker() {
    const callbacks = createTracker({ initialThreadId: "root-thread" });
    const socket = attachFakeSocket(callbacks.tracker);
    const ask = (threadId = "root-thread") =>
      socket.receive({
        method: "item/completed",
        params: {
          threadId,
          turnId: "turn-1",
          item: {
            id: "question-1",
            type: "agentMessage",
            delivery: "async",
            phase: "final_answer",
            text: "Which approach should I use?",
            questions: [{ title: "Which approach should I use?" }],
          },
        },
      });
    const reply = (threadId = "root-thread") =>
      socket.receive({
        method: "item/completed",
        params: {
          threadId,
          item: { id: "reply-1", type: "userMessage", content: [] },
        },
      });
    const status = (type: "active" | "idle", activeFlags: string[] = []) =>
      socket.receive({
        method: "thread/status/changed",
        params: { threadId: "root-thread", status: { type, activeFlags } },
      });

    return { ...callbacks, ...socket, ask, reply, status };
  }

  it("keeps an async question visible while the agent continues working", () => {
    const { ask, receive, status, reply, sent, onStatusChange } =
      createQuestionTracker();
    status("active");
    ask();
    status("active");
    receive({ method: "turn/started", params: { threadId: "root-thread" } });
    receive({
      method: "item/completed",
      params: {
        threadId: "root-thread",
        item: { type: "agentMessage", text: "Still working", questions: null },
      },
    });

    expect(onStatusChange.mock.calls).toEqual([
      ["running"],
      ["awaiting_approval"],
    ]);
    expect(sent()).toEqual([]);

    reply();
    expect(onStatusChange).toHaveBeenLastCalledWith("running");
  });

  it("keeps an unanswered question visible after the turn completes", () => {
    const { ask, receive, status, reply, onStatusChange, onTurnCompleted } =
      createQuestionTracker();
    ask();
    receive({
      method: "turn/completed",
      params: { threadId: "root-thread", turn: { status: "completed" } },
    });
    status("idle");

    expect(onTurnCompleted).toHaveBeenCalledWith("root-thread", "completed");
    expect(onStatusChange.mock.calls).toEqual([["awaiting_approval"]]);

    reply();
    expect(onStatusChange).toHaveBeenLastCalledWith("awaiting_user_response");
  });

  it("preserves a blocking approval when an async question is answered", () => {
    const { ask, status, reply, onStatusChange } = createQuestionTracker();
    ask();
    status("active", ["waitingOnApproval"]);
    reply();
    expect(onStatusChange.mock.calls).toEqual([["awaiting_approval"]]);

    status("active");
    expect(onStatusChange).toHaveBeenLastCalledWith("running");
  });

  it.each([
    {
      method: "turn/completed",
      params: { turn: { status: "interrupted" } },
      expectedStatus: "awaiting_user_response",
    },
    {
      method: "turn/completed",
      params: { turn: { status: "failed" } },
      expectedStatus: "error",
    },
    {
      method: "thread/closed",
      params: {},
      expectedStatus: "awaiting_user_response",
    },
    {
      method: "error",
      params: { error: "Something failed" },
      expectedStatus: "error",
    },
  ])("clears pending questions on $method ($expectedStatus)", (event) => {
    const { ask, receive, status, onStatusChange } = createQuestionTracker();
    ask();
    receive({
      method: event.method,
      params: { threadId: "root-thread", ...event.params },
    });
    expect(onStatusChange).toHaveBeenLastCalledWith(event.expectedStatus);

    status("active");
    expect(onStatusChange).toHaveBeenLastCalledWith("running");
  });

  it("scopes async questions and replies to their thread", () => {
    const { ask, status, reply, onStatusChange, onSubagentUpdate } =
      createQuestionTracker();
    status("active");
    ask("child-thread");
    expect(onStatusChange.mock.calls).toEqual([["running"]]);
    expect(onSubagentUpdate).toHaveBeenLastCalledWith({
      threadId: "child-thread",
      status: "awaiting_approval",
    });

    reply();
    expect(onSubagentUpdate).toHaveBeenCalledTimes(1);
    reply("child-thread");
    expect(onSubagentUpdate).toHaveBeenLastCalledWith({
      threadId: "child-thread",
      status: "running",
    });
  });

  it("preserves a subagent question through thread hydration and collab updates", () => {
    const { ask, receive, reply, onSubagentUpdate } = createQuestionTracker();
    ask("child-thread");
    onSubagentUpdate.mockClear();

    receive({
      method: "thread/started",
      params: {
        thread: {
          id: "child-thread",
          parentThreadId: "root-thread",
          status: { type: "active", activeFlags: [] },
        },
      },
    });
    receive({
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          tool: "wait",
          senderThreadId: "root-thread",
          receiverThreadIds: ["child-thread"],
          agentsStates: { "child-thread": { status: "completed" } },
        },
      },
    });

    expect(onSubagentUpdate).toHaveBeenNthCalledWith(
      1,
      expect.not.objectContaining({ status: expect.anything() }),
    );
    expect(onSubagentUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "awaiting_approval" }),
    );

    reply("child-thread");
    expect(onSubagentUpdate).toHaveBeenLastCalledWith({
      threadId: "child-thread",
      status: "awaiting_user_response",
    });
  });

  it.each([
    { type: "agentMessage", delivery: "async", questions: [] },
    { type: "agentMessage", delivery: "async", questions: null },
    { type: "agentMessage", delivery: "async", questions: [{}] },
    { type: "agentMessage", questions: [{ title: "Regular message" }] },
    { type: "commandExecution", status: "completed" },
  ])("ignores items that are not async questions: %j", (item) => {
    const { receive, onStatusChange } = createQuestionTracker();
    receive({
      method: "item/completed",
      params: { threadId: "root-thread", item },
    });
    expect(onStatusChange).not.toHaveBeenCalled();
  });
});

describe("CodexAppServerTracker external auth", () => {
  it("answers a token refresh request without consuming our own pending call", async () => {
    const onChatgptAuthTokensRefresh = vi.fn().mockResolvedValue({
      accessToken: "access-1",
      chatgptAccountId: "workspace-1",
      chatgptPlanType: "team",
    });
    const { tracker } = createTracker({ onChatgptAuthTokensRefresh });
    const socket = attachFakeSocket(tracker);

    const pending = tracker.readAccountRateLimits();
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    expect(socket.sent()[0]).toMatchObject({ id: 1 });

    socket.receive({
      id: 1,
      method: "account/chatgptAuthTokens/refresh",
      params: {},
    });

    await vi.waitFor(() => {
      expect(socket.send).toHaveBeenCalledTimes(2);
    });
    expect(socket.sent()[1]).toEqual({
      id: 1,
      result: {
        accessToken: "access-1",
        chatgptAccountId: "workspace-1",
        chatgptPlanType: "team",
      },
    });
    expect(settled).toBe(false);

    socket.receive({ id: 1, result: { rateLimits: "ok" } });
    await expect(pending).resolves.toEqual({ rateLimits: "ok" });
  });

  it("answers with a JSON-RPC error when the refresh handler rejects", async () => {
    const onChatgptAuthTokensRefresh = vi
      .fn()
      .mockRejectedValue(new Error("Account needs a fresh Codex login"));
    const { tracker } = createTracker({ onChatgptAuthTokensRefresh });
    const socket = attachFakeSocket(tracker);

    socket.receive({
      id: 9,
      method: "account/chatgptAuthTokens/refresh",
      params: {},
    });

    await vi.waitFor(() => {
      expect(socket.send).toHaveBeenCalledTimes(1);
    });
    expect(socket.sent()[0]).toEqual({
      id: 9,
      error: { code: -32603, message: "Account needs a fresh Codex login" },
    });
  });

  it("answers unsupported server-initiated requests instead of leaving them hanging", async () => {
    const { tracker } = createTracker();
    const socket = attachFakeSocket(tracker);

    socket.receive({ id: 4, method: "account/somethingNew", params: {} });

    await vi.waitFor(() => {
      expect(socket.send).toHaveBeenCalledTimes(1);
    });
    expect(socket.sent()[0]).toEqual({
      id: 4,
      error: {
        code: -32601,
        message: "Unsupported request account/somethingNew",
      },
    });
  });

  it("sends chatgptAuthTokens login on loginWithExternalAuth", async () => {
    const { tracker } = createTracker();
    const socket = attachFakeSocket(tracker);

    const login = tracker.loginWithExternalAuth({
      accessToken: "access-1",
      chatgptAccountId: "workspace-1",
    });

    expect(socket.sent()[0]).toEqual({
      id: 1,
      method: "account/login/start",
      params: {
        type: "chatgptAuthTokens",
        accessToken: "access-1",
        chatgptAccountId: "workspace-1",
        chatgptPlanType: null,
      },
    });

    socket.receive({ id: 1, result: { type: "chatgptAuthTokens" } });
    await expect(login).resolves.toBeUndefined();
  });
});

describe("CodexAppServerTracker handshake", () => {
  async function readInitializeParams(tracker: CodexAppServerTracker) {
    const send = vi.fn<(data: string) => void>();
    const listeners = new Map<string, (event: unknown) => void>();

    const originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = class {
      readyState = 1;
      send = send;
      close = vi.fn();
      addEventListener(type: string, listener: (event: unknown) => void) {
        listeners.set(type, listener);
      }
    } as unknown as typeof WebSocket;
    try {
      const started = tracker.start();
      await vi.waitFor(() => {
        expect(listeners.has("open")).toBe(true);
      });
      listeners.get("open")?.({});

      await vi.waitFor(() => {
        expect(send).toHaveBeenCalled();
      });
      const initialize = JSON.parse(send.mock.calls[0][0]) as {
        params: { capabilities: Record<string, unknown> };
      };

      listeners.get("message")?.({
        data: JSON.stringify({ id: 1, result: {} }),
      });
      await started;
      return initialize.params;
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  }

  it("opts into the experimental API when the session manages its own auth", async () => {
    const { tracker } = createTracker({
      onChatgptAuthTokensRefresh: async () => ({
        accessToken: "access-1",
        chatgptAccountId: "workspace-1",
      }),
    });

    const params = await readInitializeParams(tracker);

    expect(params.capabilities.experimentalApi).toBe(true);
  });

  it("stays on the stable API for sessions using the default Codex login", async () => {
    const { tracker } = createTracker();

    const params = await readInitializeParams(tracker);

    expect(params.capabilities.experimentalApi).toBe(false);
  });
});
