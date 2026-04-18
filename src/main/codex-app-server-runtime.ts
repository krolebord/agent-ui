import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import log from "./logger";

const HOST = "127.0.0.1";
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_INTERVAL_MS = 150;
const STOP_GRACE_PERIOD_MS = 2_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reserveLocalPort(): Promise<number> {
  const server = createServer();
  server.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    throw new Error("Failed to reserve a local Codex app-server port.");
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  return address.port;
}

async function waitForReady(readyUrl: string, process: ChildProcess) {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (process.exitCode != null) {
      throw new Error("Codex app-server exited before it became ready.");
    }

    try {
      const response = await fetch(readyUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Poll until the server is ready or times out.
    }

    await sleep(READY_POLL_INTERVAL_MS);
  }

  throw new Error("Timed out waiting for Codex app-server readiness.");
}

export interface CodexAppServerProcessExitPayload {
  exitCode: number | null;
  signal?: NodeJS.Signals;
}

export interface CodexAppServerProcessOptions {
  sessionId: string;
  onUnexpectedExit?: (payload: CodexAppServerProcessExitPayload) => void;
}

export class CodexAppServerProcess {
  readonly sessionId: string;

  private process: ChildProcess | null = null;
  private port: number | null = null;
  private stopping = false;
  private readonly onUnexpectedExit?: (
    payload: CodexAppServerProcessExitPayload,
  ) => void;

  constructor(options: CodexAppServerProcessOptions) {
    this.sessionId = options.sessionId;
    this.onUnexpectedExit = options.onUnexpectedExit;
  }

  get wsUrl(): string {
    if (this.port == null) {
      throw new Error("Codex app-server has not started yet.");
    }

    return `ws://${HOST}:${this.port}`;
  }

  async start(): Promise<void> {
    if (this.process) {
      return;
    }

    const port = await reserveLocalPort();
    const wsUrl = `ws://${HOST}:${port}`;
    const readyUrl = `http://${HOST}:${port}/readyz`;

    const child = spawn("codex", ["app-server", "--listen", wsUrl], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    this.port = port;
    this.process = child;
    this.stopping = false;

    child.stdout?.on("data", (chunk) => {
      log.debug("[codex-app-server stdout]", {
        sessionId: this.sessionId,
        message: String(chunk).trim(),
      });
    });

    child.stderr?.on("data", (chunk) => {
      log.warn("[codex-app-server stderr]", {
        sessionId: this.sessionId,
        message: String(chunk).trim(),
      });
    });

    child.once("exit", (exitCode, signal) => {
      const wasStopping = this.stopping;
      this.process = null;

      if (!wasStopping) {
        this.onUnexpectedExit?.({
          exitCode,
          signal: signal ?? undefined,
        });
      }
    });

    child.once("error", (error) => {
      log.error("Failed to start Codex app-server process", {
        sessionId: this.sessionId,
        error,
      });
    });

    try {
      await waitForReady(readyUrl, child);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child) {
      return;
    }

    this.stopping = true;

    const exitPromise = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });

    child.kill("SIGTERM");

    const gracefulStop = Promise.race([
      exitPromise,
      sleep(STOP_GRACE_PERIOD_MS),
    ]);
    await gracefulStop;

    if (child.exitCode == null) {
      child.kill("SIGKILL");
      await exitPromise;
    }

    this.process = null;
  }
}
