import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "../../src/main/create-services";
import { startWebAppServer } from "../../src/main/web-app-server";

const fsMockState = vi.hoisted(() => ({ failReadStream: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { PassThrough } = await import("node:stream");
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      if (fsMockState.failReadStream) {
        const stream = new PassThrough();
        queueMicrotask(() => stream.emit("error", new Error("read failed")));
        return stream;
      }
      return Reflect.apply(actual.createReadStream, actual, args);
    },
  };
});

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
    fsMockState.failReadStream = false;
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

  it("serves the web app manifest without caching", async () => {
    const reservation = await reservePort();
    await new Promise<void>((resolve) =>
      reservation.server.close(() => resolve()),
    );
    process.env.AGENT_UI_WEB_PORT = String(reservation.port);
    await writeFile(
      path.join(rendererDist, "manifest.webmanifest"),
      '{"name":"Agent UI"}',
    );

    const server = await startWebAppServer({
      rendererDist,
      getServices: () => null,
    });
    servers.push(server);

    const response = await fetch(`${server.url}/manifest.webmanifest`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/manifest+json",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe('{"name":"Agent UI"}');
  });

  it("serves the precompressed variant a client accepts", async () => {
    const reservation = await reservePort();
    await new Promise<void>((resolve) =>
      reservation.server.close(() => resolve()),
    );
    process.env.AGENT_UI_WEB_PORT = String(reservation.port);
    const assetBody = "console.log('agent ui');".repeat(200);
    await writeFile(path.join(rendererDist, "app.js"), assetBody);
    await writeFile(
      path.join(rendererDist, "app.js.gz"),
      gzipSync(Buffer.from(assetBody)),
    );

    const server = await startWebAppServer({
      rendererDist,
      getServices: () => null,
    });
    servers.push(server);

    const response = await fetch(`${server.url}/app.js`, {
      headers: { "accept-encoding": "gzip" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(response.headers.get("vary")).toBe("accept-encoding");
    // undici transparently decodes, so the body still matches the original.
    expect(await response.text()).toBe(assetBody);
  });

  it("prefers brotli over gzip when both are available", async () => {
    const reservation = await reservePort();
    await new Promise<void>((resolve) =>
      reservation.server.close(() => resolve()),
    );
    process.env.AGENT_UI_WEB_PORT = String(reservation.port);
    const assetBody = "body { color: red; }".repeat(200);
    await writeFile(path.join(rendererDist, "app.css"), assetBody);
    await writeFile(
      path.join(rendererDist, "app.css.gz"),
      gzipSync(Buffer.from(assetBody)),
    );
    await writeFile(
      path.join(rendererDist, "app.css.br"),
      brotliCompressSync(Buffer.from(assetBody)),
    );

    const server = await startWebAppServer({
      rendererDist,
      getServices: () => null,
    });
    servers.push(server);

    const response = await fetch(`${server.url}/app.css`, {
      headers: { "accept-encoding": "gzip, br" },
    });

    expect(response.headers.get("content-encoding")).toBe("br");
    expect(await response.text()).toBe(assetBody);
  });

  it("falls back to the raw file when the client rejects every variant", async () => {
    const reservation = await reservePort();
    await new Promise<void>((resolve) =>
      reservation.server.close(() => resolve()),
    );
    process.env.AGENT_UI_WEB_PORT = String(reservation.port);
    const assetBody = "console.log('agent ui');".repeat(200);
    await writeFile(path.join(rendererDist, "app.js"), assetBody);
    await writeFile(
      path.join(rendererDist, "app.js.gz"),
      gzipSync(Buffer.from(assetBody)),
    );

    const server = await startWebAppServer({
      rendererDist,
      getServices: () => null,
    });
    servers.push(server);

    const response = await fetch(`${server.url}/app.js`, {
      headers: { "accept-encoding": "gzip;q=0" },
    });

    expect(response.headers.get("content-encoding")).toBe(null);
    expect(response.headers.get("content-length")).toBe(
      String(Buffer.byteLength(assetBody)),
    );
    expect(await response.text()).toBe(assetBody);
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

  it("uses an ASCII fallback for artifact names with Unicode characters", async () => {
    const reservation = await reservePort();
    await new Promise<void>((resolve) =>
      reservation.server.close(() => resolve()),
    );
    process.env.AGENT_UI_WEB_PORT = String(reservation.port);
    const artifactPath = path.join(rendererDist, "unicode-artifact.txt");
    await writeFile(artifactPath, "agent output");
    const services = {
      artifactsService: {
        state: {
          state: {
            artifact1: {
              id: "artifact1",
              sessionId: "session1",
              path: artifactPath,
              name: "报告-📊.txt",
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
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="__-_.txt"; filename*=UTF-8''${encodeURIComponent("报告-📊.txt")}`,
    );
    expect(await response.text()).toBe("agent output");
  });

  it("marks an artifact unavailable when its read stream fails", async () => {
    const reservation = await reservePort();
    await new Promise<void>((resolve) =>
      reservation.server.close(() => resolve()),
    );
    process.env.AGENT_UI_WEB_PORT = String(reservation.port);
    const artifactPath = path.join(rendererDist, "unreadable-artifact.txt");
    await writeFile(artifactPath, "agent output");
    const markUnavailable = vi.fn();
    const services = {
      artifactsService: {
        state: {
          state: {
            artifact1: {
              id: "artifact1",
              sessionId: "session1",
              path: artifactPath,
              name: "unreadable-artifact.txt",
              size: 12,
              mimeType: "text/plain",
              createdAt: Date.now(),
              available: true,
            },
          },
        },
        markUnavailable,
      },
    } as unknown as Services;

    const server = await startWebAppServer({
      rendererDist,
      getServices: () => services,
    });
    servers.push(server);
    fsMockState.failReadStream = true;

    const response = await fetch(`${server.url}/artifacts/artifact1/download`);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Artifact file is no longer available");
    expect(markUnavailable).toHaveBeenCalledWith("artifact1");
  });
});
