import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Services } from "../../../src/main/create-services";
import { handleMcpHttpRequest, MCP_PATH } from "../../../src/main/mcp/server";
import { McpSessionTokens } from "../../../src/main/mcp/session-token";
import type { SkillEntry } from "../../../src/shared/skills";

const mcpSessionTokens = new McpSessionTokens();
const listSkillsForPath = vi.fn(
  async (_cwd: string | null): Promise<SkillEntry[]> => [],
);
const services = {
  mcpSessionTokens,
  skillsService: { listSkillsForPath },
} as unknown as Services;

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

  beforeEach(() => {
    listSkillsForPath.mockClear();
  });

  async function connectClient(token?: string) {
    const url = token ? `${baseUrl}?token=${token}` : baseUrl;
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return client;
  }

  it("lists the registered tools", async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toContain("hello_world");
      expect(names).toContain("list_skills");
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

  it("resolves the session cwd from the URL token for list_skills", async () => {
    const skill: SkillEntry = {
      name: "deploy",
      scope: { type: "project", projectPath: "/home/user/project" },
      description: "Deploys the app",
      body: "Do the thing.\n",
      userInvokeOnly: true,
      managedBy: "app",
      dirPath: "/home/user/project/.agents/skills/deploy",
      hasExtraFiles: false,
      updatedAt: 123,
    };
    listSkillsForPath.mockResolvedValueOnce([skill]);

    const token = mcpSessionTokens.sign({ cwd: "/home/user/project" });
    const client = await connectClient(token);
    try {
      const result = await client.callTool({
        name: "list_skills",
        arguments: {},
      });
      expect(listSkillsForPath).toHaveBeenCalledWith("/home/user/project");
      const [content] = result.content as [{ type: string; text: string }];
      expect(JSON.parse(content.text)).toEqual({
        skills: [
          {
            name: "deploy",
            description: "Deploys the app",
            scope: { type: "project", projectPath: "/home/user/project" },
            userInvokeOnly: true,
            dirPath: "/home/user/project/.agents/skills/deploy",
          },
        ],
      });
    } finally {
      await client.close();
    }
  });

  it("falls back to a null cwd without a token", async () => {
    const client = await connectClient();
    try {
      await client.callTool({ name: "list_skills", arguments: {} });
      expect(listSkillsForPath).toHaveBeenCalledWith(null);
    } finally {
      await client.close();
    }
  });

  it("falls back to a null cwd for a forged token", async () => {
    const forged = new McpSessionTokens().sign({ cwd: "/home/user/project" });
    const client = await connectClient(forged);
    try {
      await client.callTool({ name: "list_skills", arguments: {} });
      expect(listSkillsForPath).toHaveBeenCalledWith(null);
    } finally {
      await client.close();
    }
  });
});
