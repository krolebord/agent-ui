import log from "./logger";

export type CodexAppServerSessionState =
  | "idle"
  | "running"
  | "awaiting_approval"
  | "awaiting_user_response"
  | "error";

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

export interface CodexAppServerTrackerOptions {
  sessionId: string;
  wsUrl: string;
  initialThreadId?: string;
  onThreadId?: (threadId: string) => void;
  onStatusChange?: (status: CodexAppServerSessionState) => void;
  onTitleUpdated?: (title: string) => void;
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
    return "idle";
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

export class CodexAppServerTracker {
  private readonly sessionId: string;
  private readonly wsUrl: string;
  private readonly onThreadId?: (threadId: string) => void;
  private readonly onStatusChange?: (
    status: CodexAppServerSessionState,
  ) => void;
  private readonly onTitleUpdated?: (title: string) => void;
  private readonly onError?: (errorMessage: string) => void;
  private readonly pendingRequests = new Map<number, PendingRequest>();

  private ws: WebSocket | null = null;
  private nextRequestId = 1;
  private threadId: string | undefined;
  private lastStatus: CodexAppServerSessionState | null = null;
  private shouldTreatIdleAsAwaitingUserResponse = false;

  constructor(options: CodexAppServerTrackerOptions) {
    this.sessionId = options.sessionId;
    this.wsUrl = options.wsUrl;
    this.threadId = options.initialThreadId;
    this.onThreadId = options.onThreadId;
    this.onStatusChange = options.onStatusChange;
    this.onTitleUpdated = options.onTitleUpdated;
    this.onError = options.onError;
    this.shouldTreatIdleAsAwaitingUserResponse = !!options.initialThreadId;
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
          "item/completed",
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

        const threadId =
          "id" in thread && typeof thread.id === "string"
            ? thread.id
            : undefined;
        if (threadId) {
          this.setThreadId(threadId);
        }

        const threadName =
          "name" in thread && typeof thread.name === "string"
            ? thread.name
            : undefined;
        const preview =
          "preview" in thread && typeof thread.preview === "string"
            ? thread.preview
            : undefined;

        const title = threadName?.trim() || preview?.trim();
        if (title) {
          this.onTitleUpdated?.(title);
        }
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

        this.setThreadId(threadId);
        if (this.threadId !== threadId) {
          return;
        }

        const nextStatus = this.normalizeDisplayStatus(mapThreadStatus(status));
        if (!nextStatus || this.lastStatus === nextStatus) {
          return;
        }

        this.lastStatus = nextStatus;
        this.onStatusChange?.(nextStatus);
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

        this.setThreadId(threadId);
        if (this.threadId !== threadId) {
          return;
        }

        this.shouldTreatIdleAsAwaitingUserResponse = true;
        if (this.lastStatus === "running") {
          return;
        }

        this.lastStatus = "running";
        this.onStatusChange?.("running");
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

        this.setThreadId(threadId);
        if (this.threadId !== threadId) {
          return;
        }

        this.shouldTreatIdleAsAwaitingUserResponse = true;

        if (turn.status === "failed") {
          this.lastStatus = "error";
          this.onStatusChange?.("error");
          return;
        }

        if (this.lastStatus === "awaiting_user_response") {
          return;
        }

        this.lastStatus = "awaiting_user_response";
        this.onStatusChange?.("awaiting_user_response");
        return;
      }

      case "thread/name/updated": {
        const threadId =
          typeof message.params?.threadId === "string"
            ? message.params.threadId
            : undefined;
        const threadName =
          typeof message.params?.threadName === "string"
            ? message.params.threadName.trim()
            : "";
        if (!threadId || !threadName) {
          return;
        }

        this.setThreadId(threadId);
        if (this.threadId !== threadId) {
          return;
        }

        this.onTitleUpdated?.(threadName);
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

        this.setThreadId(threadId);
        if (this.threadId !== threadId) {
          return;
        }

        const nextStatus = this.normalizeDisplayStatus("idle");
        if (!nextStatus || this.lastStatus === nextStatus) {
          return;
        }

        this.lastStatus = nextStatus;
        this.onStatusChange?.(nextStatus);
        return;
      }

      case "error": {
        const error = message.params?.error;
        const errorMessage = getErrorMessage(error);
        this.lastStatus = "error";
        this.onStatusChange?.("error");
        this.onError?.(errorMessage);
        return;
      }

      default:
        return;
    }
  }

  private setThreadId(threadId: string) {
    if (this.threadId === threadId) {
      return;
    }

    this.threadId = threadId;
    this.onThreadId?.(threadId);
  }

  private normalizeDisplayStatus(
    status: CodexAppServerSessionState | null,
  ): CodexAppServerSessionState | null {
    if (status !== "idle") {
      return status;
    }

    return this.shouldTreatIdleAsAwaitingUserResponse
      ? "awaiting_user_response"
      : "idle";
  }
}
