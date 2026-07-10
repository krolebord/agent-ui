import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Services } from "../../../src/main/create-services";
import { handleMcpHttpRequest, MCP_PATH } from "../../../src/main/mcp/server";

// hello_world does not touch services, so an empty stub is enough here.
const services = {} as Services;

describe("mcp server", () => {
  let httpServer: Server;
  let baseUrl: string;

  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      void handleMcpHttpRequest(req, res, services);
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}${MCP_PATH}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  });

  async function connectClient() {
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl)));
    return client;
  }

  it("lists the hello_world tool", async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain("hello_world");
    } finally {
      await client.close();
    }
  });

  it("calls hello_world with a name", async () => {
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: "hello_world",
        arguments: { name: "Kiril" },
      });
      expect(result.content).toEqual([
        {
          type: "text",
          text: "Hello, Kiril! Agent UI is up and reachable over MCP.",
        },
      ]);
    } finally {
      await client.close();
    }
  });

  it("calls hello_world with empty arguments", async () => {
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: "hello_world",
        arguments: {},
      });
      expect(result.content).toEqual([
        {
          type: "text",
          text: "Hello, world! Agent UI is up and reachable over MCP.",
        },
      ]);
    } finally {
      await client.close();
    }
  });

  it("rejects invalid arguments", async () => {
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: "hello_world",
        arguments: { name: 42 },
      });
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
