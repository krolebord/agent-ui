import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/ws";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import type { Services } from "./create-services";
import log from "./logger";
import { handleMcpHttpRequest, MCP_PATH } from "./mcp/server";
import { orpcRouter } from "./orpc-router";

interface WebAppServerOptions {
  rendererDist: string;
  viteDevServerUrl?: string;
  getServices: () => Services | null;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3420;
const MAX_PORT_ATTEMPTS = 20;

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function getConfig() {
  const requestedPort = Number(process.env.AGENT_UI_WEB_PORT);
  const port =
    Number.isInteger(requestedPort) && requestedPort > 0
      ? requestedPort
      : DEFAULT_PORT;
  return { host: DEFAULT_HOST, port };
}

function sendText(
  res: ServerResponse,
  statusCode: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
) {
  res.writeHead(statusCode, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function isMcpRequest(req: IncomingMessage) {
  const pathname = new URL(req.url ?? "/", "http://agent-ui.local").pathname;
  return pathname === MCP_PATH;
}

function getWebSocketUrl(req: IncomingMessage, port: number) {
  const hostHeader = req.headers.host;
  const host = hostHeader?.replace(/:\d+$/, "") || "127.0.0.1";
  return `ws://${host}:${port}/rpc`;
}

function redirectToVite(
  req: IncomingMessage,
  res: ServerResponse,
  viteDevServerUrl: string,
  port: number,
) {
  const target = new URL(viteDevServerUrl);
  target.searchParams.set("agentUiWs", getWebSocketUrl(req, port));
  res.writeHead(302, {
    location: target.toString(),
    "cache-control": "no-store",
  });
  res.end();
}

function resolveStaticPath(rendererDist: string, requestUrl: string) {
  const url = new URL(requestUrl, "http://agent-ui.local");
  const decodedPathname = decodeURIComponent(url.pathname);
  const relativePath =
    decodedPathname === "/"
      ? "index.html"
      : decodedPathname.replace(/^\/+/, "");
  const filePath = path.resolve(rendererDist, relativePath);
  const root = path.resolve(rendererDist);

  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    return null;
  }

  return filePath;
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  rendererDist: string,
) {
  const resolvedPath = resolveStaticPath(rendererDist, req.url ?? "/");
  if (!resolvedPath) {
    sendText(res, 403, "Forbidden");
    return;
  }

  const filePath = await stat(resolvedPath)
    .then((stats) =>
      stats.isFile() ? resolvedPath : path.join(resolvedPath, "index.html"),
    )
    .catch(() => path.join(rendererDist, "index.html"));

  const stats = await stat(filePath).catch(() => null);
  if (!stats?.isFile()) {
    sendText(res, 404, "Not found");
    return;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, {
    "content-type": contentTypes[ext] ?? "application/octet-stream",
    "content-length": stats.size,
    "cache-control": filePath.endsWith("index.html")
      ? "no-store"
      : "public, max-age=31536000, immutable",
  });
  createReadStream(filePath).pipe(res);
}

function listen(
  server: ReturnType<typeof createServer>,
  host: string,
  port: number,
) {
  return new Promise<number>((resolve, reject) => {
    const handleError = (error: NodeJS.ErrnoException) => {
      server.off("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off("error", handleError);
      resolve(port);
    };

    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(port, host);
  });
}

export async function startWebAppServer(options: WebAppServerOptions) {
  const config = getConfig();
  const rpcHandler = new RPCHandler(orpcRouter, {
    interceptors: [
      onError((error) => {
        console.error(error);
      }),
    ],
  });
  const wss = new WebSocketServer({ noServer: true });

  let boundPort = config.port;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/rpc")) {
      sendText(res, 426, "WebSocket upgrade required");
      return;
    }

    if (isMcpRequest(req)) {
      const services = options.getServices();
      if (!services) {
        sendText(res, 503, "Service unavailable");
        return;
      }
      void handleMcpHttpRequest(req, res, services);
      return;
    }

    if (options.viteDevServerUrl) {
      redirectToVite(req, res, options.viteDevServerUrl, boundPort);
      return;
    }

    void serveStatic(req, res, options.rendererDist);
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    if (url.pathname !== "/rpc") {
      socket.destroy();
      return;
    }

    const services = options.getServices();
    if (!services) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    const services = options.getServices();
    if (!services) {
      ws.close();
      return;
    }

    void rpcHandler.upgrade(ws, {
      context: services,
    });
  });

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
    const port = config.port + attempt;
    try {
      boundPort = await listen(server, config.host, port);
      break;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "EADDRINUSE" &&
        attempt < MAX_PORT_ATTEMPTS - 1
      ) {
        continue;
      }
      throw error;
    }
  }

  const url = `http://${config.host}:${boundPort}`;
  log.info("Web app server started", {
    url,
    mode: options.viteDevServerUrl ? "dev" : "static",
  });

  return {
    url,
    close: async () => {
      for (const client of wss.clients) {
        client.close();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      const closePromise = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      server.closeIdleConnections();
      server.closeAllConnections();
      await closePromise;
    },
  };
}
