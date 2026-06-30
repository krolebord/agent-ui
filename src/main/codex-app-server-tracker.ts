import log from "./logger";

export type CodexAppServerSessionState =
  | "running"
  | "awaiting_approval"
  | "awaiting_user_response"
  | "error";

export type CodexAppServerCollabAgentStatus =
  | "pendingInit"
  | "running"
  | "interrupted"
  | "completed"
  | "errored"
  | "shutdown"
  | "notFound";

export interface CodexAppServerSubagentUpdate {
  threadId: string;
  parentThreadId?: string;
  nickname?: string;
  role?: string;
  preview?: string;
  initialPrompt?: string;
  status?: CodexAppServerSessionState | "starting" | "stopped";
  collabStatus?: CodexAppServerCollabAgentStatus;
  message?: string;
  createdAt?: number;
  updatedAt?: number;
}

interface JsonRpcRequest {
  id: number;
  method: string;
  params: unknown;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: unknown;
}

interface JsonRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type CodexThreadReadResponse = {
  thread?: {
    preview?: unknown;
    turns?: unknown;
  };
};

export interface CodexAppServerTrackerOptions {
  sessionId: string;
  wsUrl: string;
  initialThreadId?: string;
  onThreadId?: (threadId: string) => void;
  onStatusChange?: (status: CodexAppServerSessionState) => void;
  onThreadStatusChange?: (
    threadId: string,
    status: CodexAppServerSessionState,
  ) => void;
  onSubagentUpdate?: (update: CodexAppServerSubagentUpdate) => void;
  onError?: (errorMessage: string) => void;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown Codex app-server error";
  }
}

function mapThreadStatus(status: object): CodexAppServerSessionState | null {
  const threadStatus = status as {
    type?: unknown;
    activeFlags?: unknown;
  };
  if (threadStatus.type === "idle") {
    return "awaiting_user_response";
  }

  if (threadStatus.type === "systemError") {
    return "error";
  }

  if (threadStatus.type !== "active") {
    return null;
  }

  const activeFlags = Array.isArray(threadStatus.activeFlags)
    ? threadStatus.activeFlags
    : [];
  if (activeFlags.includes("waitingOnApproval")) {
    return "awaiting_approval";
  }

  if (activeFlags.includes("waitingOnUserInput")) {
    return "awaiting_approval";
  }

  return "running";
}

function mapCollabAgentStatus(
  status: CodexAppServerCollabAgentStatus,
): CodexAppServerSubagentUpdate["status"] {
  switch (status) {
    case "pendingInit":
      return "starting";
    case "running":
      return "running";
    case "completed":
      return "awaiting_user_response";
    case "errored":
    case "notFound":
      return "error";
    case "interrupted":
    case "shutdown":
      return "stopped";
  }
}

function getTextFromUserInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const item = input as { type?: unknown; text?: unknown };
  if (item.type !== "text" || typeof item.text !== "string") {
    return undefined;
  }

  return item.text.trim() || undefined;
}

function getPromptFromThreadReadResponse(
  response: unknown,
): string | undefined {
  const thread = (response as CodexThreadReadResponse | undefined)?.thread;
  if (!thread || typeof thread !== "object") {
    return undefined;
  }

  if (typeof thread.preview === "string" && thread.preview.trim()) {
    return thread.preview.trim();
  }

  if (!Array.isArray(thread.turns)) {
    return undefined;
  }

  for (const turn of thread.turns) {
    if (!turn || typeof turn !== "object") {
      continue;
    }

    const items = (turn as { items?: unknown }).items;
    if (!Array.isArray(items)) {
      continue;
    }

    for (const item of items) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const threadItem = item as { type?: unknown; content?: unknown };
      if (
        threadItem.type !== "userMessage" ||
        !Array.isArray(threadItem.content)
      ) {
        continue;
      }

      const text = threadItem.content
        .map(getTextFromUserInput)
        .filter((part): part is string => !!part)
        .join("\n")
        .trim();
      if (text) {
        return text;
      }
    }
  }

  return undefined;
}

export class CodexAppServerTracker {
  private readonly sessionId: string;
  private readonly wsUrl: string;
  private readonly onThreadId?: (threadId: string) => void;
  private readonly onStatusChange?: (
    status: CodexAppServerSessionState,
  ) => void;
  private readonly onThreadStatusChange?: (
    threadId: string,
    status: CodexAppServerSessionState,
  ) => void;
  private readonly onSubagentUpdate?: (
    update: CodexAppServerSubagentUpdate,
  ) => void;
  private readonly onError?: (errorMessage: string) => void;
  private readonly pendingRequests = new Map<number, PendingRequest>();

  private ws: WebSocket | null = null;
  private nextRequestId = 1;
  private threadId: string | undefined;
  private readonly threadStatuses = new Map<
    string,
    CodexAppServerSessionState
  >();
  private readonly hydratedSubagentThreads = new Set<string>();

  constructor(options: CodexAppServerTrackerOptions) {
    this.sessionId = options.sessionId;
    this.wsUrl = options.wsUrl;
    this.threadId = options.initialThreadId;
    this.onThreadId = options.onThreadId;
    this.onStatusChange = options.onStatusChange;
    this.onThreadStatusChange = options.onThreadStatusChange;
    this.onSubagentUpdate = options.onSubagentUpdate;
    this.onError = options.onError;
  }

  async start(): Promise<void> {
    if (this.ws) {
      return;
    }

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl);
      socket.addEventListener("open", () => resolve(socket), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("Failed to connect to Codex app-server.")),
        { once: true },
      );
    });

    this.ws = ws;

    ws.addEventListener("message", (event) => {
      this.handleMessage(String(event.data));
    });

    ws.addEventListener("close", () => {
      this.ws = null;
      this.rejectPendingRequests(
        new Error("Codex app-server tracker connection closed."),
      );
    });

    await this.call("initialize", {
      clientInfo: {
        name: "claude_ui",
        title: "Claude UI",
        version: "0.0.0",
      },
      capabilities: {
        experimentalApi: false,
        optOutNotificationMethods: [
          "item/started",
          "item/agentMessage/delta",
          "item/plan/delta",
          "item/commandExecution/outputDelta",
          "item/fileChange/outputDelta",
        ],
      },
    });

    ws.send(JSON.stringify({ method: "initialized", params: {} }));

    void this.call("account/read", { refreshToken: false }).catch((error) => {
      log.warn("Failed to read Codex account state from app-server", {
        sessionId: this.sessionId,
        error,
      });
    });
  }

  async stop(): Promise<void> {
    this.rejectPendingRequests(
      new Error("Codex app-server tracker connection stopped."),
    );

    const ws = this.ws;
    this.ws = null;

    if (!ws) {
      return;
    }

    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }

      ws.addEventListener("close", () => resolve(), { once: true });
      ws.close();
    });
  }

  async readThreadPrompt(
    threadId = this.threadId,
  ): Promise<string | undefined> {
    if (!threadId) {
      return undefined;
    }

    const response = await this.call("thread/read", {
      threadId,
      includeTurns: true,
    });
    return getPromptFromThreadReadResponse(response);
  }

  private rejectPendingRequests(error: Error) {
    const requests = Array.from(this.pendingRequests.values());
    this.pendingRequests.clear();

    for (const request of requests) {
      request.reject(error);
    }
  }

  private async call(method: string, params: unknown): Promise<unknown> {
    const ws = this.ws;
    if (!ws) {
      throw new Error("Codex app-server tracker is not connected.");
    }

    const id = this.nextRequestId++;
    const request: JsonRpcRequest = { id, method, params };

    const responsePromise = new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });

    ws.send(JSON.stringify(request));
    return await responsePromise;
  }

  private handleMessage(rawMessage: string) {
    let message: JsonRpcResponse | JsonRpcNotification;
    try {
      message = JSON.parse(rawMessage);
    } catch (error) {
      log.warn("Failed to parse Codex app-server tracker message", {
        sessionId: this.sessionId,
        rawMessage,
        error,
      });
      return;
    }

    if ("id" in message) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }

      this.pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(getErrorMessage(message.error)));
        return;
      }

      pending.resolve(message.result);
      return;
    }

    this.handleNotification(message);
  }

  private handleNotification(message: JsonRpcNotification) {
    switch (message.method) {
      case "thread/started": {
        const thread = message.params?.thread;
        if (!thread || typeof thread !== "object") {
          return;
        }

        this.handleThread(thread);
        return;
      }

      case "thread/status/changed": {
        const threadId =
          typeof message.params?.threadId === "string"
            ? message.params.threadId
            : undefined;
        const status =
          message.params?.status && typeof message.params.status === "object"
            ? message.params.status
            : undefined;
        if (!threadId || !status) {
          return;
        }

        if (!this.threadId) {
          this.setThreadId(threadId);
        }

        const nextStatus = mapThreadStatus(status);
        if (!nextStatus) {
          return;
        }

        this.emitThreadStatus(threadId, nextStatus);
        return;
      }

      case "turn/started": {
        const threadId =
          typeof message.params?.threadId === "string"
            ? message.params.threadId
            : undefined;
        if (!threadId) {
          return;
        }

        if (!this.threadId) {
          this.setThreadId(threadId);
        }
        this.emitThreadStatus(threadId, "running");
        return;
      }

      case "turn/completed": {
        const threadId =
          typeof message.params?.threadId === "string"
            ? message.params.threadId
            : undefined;
        const turn =
          message.params?.turn && typeof message.params.turn === "object"
            ? (message.params.turn as { status?: unknown })
            : undefined;
        if (!threadId || !turn) {
          return;
        }

        if (!this.threadId) {
          this.setThreadId(threadId);
        }

        if (turn.status === "failed") {
          this.emitThreadStatus(threadId, "error");
          return;
        }

        this.emitThreadStatus(threadId, "awaiting_user_response");
        return;
      }

      case "thread/closed": {
        const threadId =
          typeof message.params?.threadId === "string"
            ? message.params.threadId
            : undefined;
        if (!threadId) {
          return;
        }

        if (!this.threadId) {
          this.setThreadId(threadId);
        }

        const nextStatus = "awaiting_user_response";
        this.emitThreadStatus(threadId, nextStatus);
        return;
      }

      case "item/completed": {
        this.handleCompletedItem(message.params);
        return;
      }

      case "error": {
        const error = message.params?.error;
        const errorMessage = getErrorMessage(error);
        const threadId =
          typeof message.params?.threadId === "string"
            ? message.params.threadId
            : this.threadId;
        if (threadId) {
          this.emitThreadStatus(threadId, "error");
        } else {
          this.onStatusChange?.("error");
        }
        this.onError?.(errorMessage);
        return;
      }

      default:
        return;
    }
  }

  private handleThread(thread: object) {
    const threadRecord = thread as {
      id?: unknown;
      parentThreadId?: unknown;
      preview?: unknown;
      status?: unknown;
      agentNickname?: unknown;
      agentRole?: unknown;
      createdAt?: unknown;
      updatedAt?: unknown;
    };
    const threadId =
      typeof threadRecord.id === "string" ? threadRecord.id : undefined;
    if (!threadId) {
      return;
    }

    const parentThreadId =
      typeof threadRecord.parentThreadId === "string"
        ? threadRecord.parentThreadId
        : undefined;

    if (parentThreadId) {
      const status =
        threadRecord.status && typeof threadRecord.status === "object"
          ? mapThreadStatus(threadRecord.status)
          : null;
      this.onSubagentUpdate?.({
        threadId,
        parentThreadId,
        nickname:
          typeof threadRecord.agentNickname === "string"
            ? threadRecord.agentNickname
            : undefined,
        role:
          typeof threadRecord.agentRole === "string"
            ? threadRecord.agentRole
            : undefined,
        preview:
          typeof threadRecord.preview === "string"
            ? threadRecord.preview
            : undefined,
        status: status ?? undefined,
        createdAt:
          typeof threadRecord.createdAt === "number"
            ? threadRecord.createdAt
            : undefined,
        updatedAt:
          typeof threadRecord.updatedAt === "number"
            ? threadRecord.updatedAt
            : undefined,
      });
      if (status) {
        this.emitThreadStatus(threadId, status);
      }
      return;
    }

    this.setThreadId(threadId);
  }

  private handleCompletedItem(params: Record<string, unknown> | undefined) {
    const item = params?.item;
    if (!item || typeof item !== "object") {
      return;
    }

    const collabItem = item as {
      type?: unknown;
      tool?: unknown;
      senderThreadId?: unknown;
      receiverThreadIds?: unknown;
      prompt?: unknown;
      agentsStates?: unknown;
    };
    if (collabItem.type !== "collabAgentToolCall") {
      return;
    }

    const senderThreadId =
      typeof collabItem.senderThreadId === "string"
        ? collabItem.senderThreadId
        : undefined;
    const receiverThreadIds = Array.isArray(collabItem.receiverThreadIds)
      ? collabItem.receiverThreadIds.filter(
          (threadId): threadId is string => typeof threadId === "string",
        )
      : [];
    const agentsStates =
      collabItem.agentsStates && typeof collabItem.agentsStates === "object"
        ? (collabItem.agentsStates as Record<string, unknown>)
        : {};

    for (const receiverThreadId of receiverThreadIds) {
      const agentState = agentsStates[receiverThreadId];
      const update: CodexAppServerSubagentUpdate = {
        threadId: receiverThreadId,
        parentThreadId: senderThreadId,
      };
      if (typeof collabItem.prompt === "string") {
        update.initialPrompt = collabItem.prompt;
      }
      if (agentState && typeof agentState === "object") {
        const state = agentState as { status?: unknown; message?: unknown };
        if (isCollabAgentStatus(state.status)) {
          update.collabStatus = state.status;
          update.status = mapCollabAgentStatus(state.status);
        }
        if (typeof state.message === "string") {
          update.message = state.message;
        }
      }

      this.onSubagentUpdate?.(update);

      if (collabItem.tool === "spawnAgent" && this.ws) {
        void this.hydrateSubagentThread(receiverThreadId).catch((error) => {
          log.warn("Failed to hydrate Codex subagent thread", {
            sessionId: this.sessionId,
            threadId: receiverThreadId,
            error,
          });
        });
      }
    }
  }

  private async hydrateSubagentThread(threadId: string): Promise<void> {
    if (this.hydratedSubagentThreads.has(threadId)) {
      return;
    }
    this.hydratedSubagentThreads.add(threadId);

    const response = await this.call("thread/read", {
      threadId,
      includeTurns: false,
    });
    const thread = (response as { thread?: unknown }).thread;
    if (!thread || typeof thread !== "object") {
      return;
    }

    this.handleThread(thread);
  }

  private emitThreadStatus(
    threadId: string,
    nextStatus: CodexAppServerSessionState,
  ) {
    if (this.threadStatuses.get(threadId) === nextStatus) {
      return;
    }

    this.threadStatuses.set(threadId, nextStatus);
    this.onThreadStatusChange?.(threadId, nextStatus);
    if (this.threadId === threadId) {
      this.onStatusChange?.(nextStatus);
      return;
    }
    this.onSubagentUpdate?.({ threadId, status: nextStatus });
  }

  private setThreadId(threadId: string) {
    if (this.threadId === threadId) {
      return;
    }

    this.threadId = threadId;
    this.onThreadId?.(threadId);
  }
}

function isCollabAgentStatus(
  status: unknown,
): status is CodexAppServerCollabAgentStatus {
  return (
    status === "pendingInit" ||
    status === "running" ||
    status === "interrupted" ||
    status === "completed" ||
    status === "errored" ||
    status === "shutdown" ||
    status === "notFound"
  );
}
