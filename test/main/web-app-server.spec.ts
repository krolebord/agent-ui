import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Services } from "../../src/main/create-services";
import { startWebAppServer } from "../../src/main/web-app-server";

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to reserve test port");
  }
  return { server, port: address.port };
}

describe("web app server", () => {
  let rendererDist: string;
  const servers: Array<{ close(): Promise<void> }> = [];
  const occupiedServers: ReturnType<typeof createServer>[] = [];
  const originalPort = process.env.AGENT_UI_WEB_PORT;
  const originalHost = process.env.AGENT_UI_WEB_HOST;

  beforeEach(async () => {
    rendererDist = await mkdtemp(
      path.join(os.tmpdir(), "agent-ui-web-server-"),
    );
    await writeFile(
      path.join(rendererDist, "index.html"),
      '<div id="root"></div>',
    );
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(
      occupiedServers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
    await rm(rendererDist, { recursive: true, force: true });
    if (originalPort === undefined) delete process.env.AGENT_UI_WEB_PORT;
    else process.env.AGENT_UI_WEB_PORT = originalPort;
    if (originalHost === undefined) delete process.env.AGENT_UI_WEB_HOST;
    else process.env.AGENT_UI_WEB_HOST = originalHost;
  });

  it("always binds to 127.0.0.1 and serves the renderer", async () => {
    const reservation = await reservePort();
    await new Promise<void>((resolve) =>
      reservation.server.close(() => resolve()),
    );
    process.env.AGENT_UI_WEB_PORT = String(reservation.port);
    process.env.AGENT_UI_WEB_HOST = "0.0.0.0";

    const server = await startWebAppServer({
      rendererDist,
      getServices: () => null,
    });
    servers.push(server);

    expect(server.url).toBe(`http://127.0.0.1:${reservation.port}`);
    const response = await fetch(server.url);
    expect(await response.text()).toBe('<div id="root"></div>');
  });

  it("uses the next port when the requested port is occupied", async () => {
    const reservation = await reservePort();
    occupiedServers.push(reservation.server);
    process.env.AGENT_UI_WEB_PORT = String(reservation.port);

    const server = await startWebAppServer({
      rendererDist,
      getServices: () => null,
    });
    servers.push(server);

    expect(server.url).toBe(`http://127.0.0.1:${reservation.port + 1}`);
  });

  it("streams published artifacts as attachments", async () => {
    const reservation = await reservePort();
    await new Promise<void>((resolve) =>
      reservation.server.close(() => resolve()),
    );
    process.env.AGENT_UI_WEB_PORT = String(reservation.port);
    const artifactPath = path.join(rendererDist, "generated report.txt");
    await writeFile(artifactPath, "agent output");
    const services = {
      artifactsService: {
        state: {
          state: {
            artifact1: {
              id: "artifact1",
              sessionId: "session1",
              path: artifactPath,
              name: "generated report.txt",
              size: 12,
              mimeType: "text/plain",
              createdAt: Date.now(),
              available: true,
            },
          },
        },
        markUnavailable() {},
      },
    } as unknown as Services;

    const server = await startWebAppServer({
      rendererDist,
      getServices: () => services,
    });
    servers.push(server);

    const response = await fetch(`${server.url}/artifacts/artifact1/download`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(
      'attachment; filename="generated report.txt"',
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe("agent output");
  });
});
