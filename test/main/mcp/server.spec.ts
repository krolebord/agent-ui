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
const createScheduledSession = vi.fn();
const updateScheduledSession = vi.fn();
const deleteScheduledSession = vi.fn();
const getScheduledSession = vi.fn();
const listScheduledSessions = vi.fn(() => []);
const services = {
  mcpSessionTokens,
  skillsService: { listSkillsForPath },
  scheduledSessionsService: {
    create: createScheduledSession,
    update: updateScheduledSession,
    delete: deleteScheduledSession,
    get: getScheduledSession,
    list: listScheduledSessions,
  },
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
    createScheduledSession.mockClear();
    updateScheduledSession.mockClear();
    deleteScheduledSession.mockClear();
    getScheduledSession.mockReset();
    listScheduledSessions.mockClear();
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
      const toolNames = tools.map((tool) => tool.name);
      expect(toolNames).toContain("list_skills");
      expect(toolNames).toContain("create_scheduled_session");
      expect(toolNames).toContain("update_scheduled_session");
      expect(toolNames).toContain("delete_scheduled_session");
      expect(toolNames).toContain("list_scheduled_sessions");
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

    const token = mcpSessionTokens.sign({
      cwd: "/home/user/project",
      canScheduleSessions: true,
    });
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

  it("creates an agent-owned, disabled scheduled session", async () => {
    createScheduledSession.mockReturnValueOnce({ id: "sched-1" });
    const token = mcpSessionTokens.sign({
      cwd: "/home/user/project",
      canScheduleSessions: true,
    });
    const client = await connectClient(token);
    try {
      const result = await client.callTool({
        name: "create_scheduled_session",
        arguments: {
          name: "Nightly triage",
          schedule: { kind: "recurring", cron: "0 9 * * *" },
          config: {
            type: "claude",
            cwd: "/home/user/project",
            initialPrompt: "triage CI failures",
          },
        },
      });
      expect(result.isError).toBeFalsy();
      expect(createScheduledSession).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Nightly triage",
          schedule: { kind: "recurring", cron: "0 9 * * *" },
          createdBy: "agent",
          enabled: false,
        }),
      );
      const [content] = result.content as [{ type: string; text: string }];
      expect(JSON.parse(content.text)).toMatchObject({
        id: "sched-1",
        status: "pending-approval",
      });
    } finally {
      await client.close();
    }
  });

  it("translates an immediate schedule into a one-time run at now", async () => {
    createScheduledSession.mockReturnValueOnce({ id: "sched-2" });
    const token = mcpSessionTokens.sign({
      cwd: "/home/user/project",
      canScheduleSessions: true,
    });
    const client = await connectClient(token);
    try {
      const before = Date.now();
      await client.callTool({
        name: "create_scheduled_session",
        arguments: {
          schedule: { kind: "immediate" },
          config: { type: "claude", cwd: "/home/user/project" },
        },
      });
      const input = createScheduledSession.mock.calls[0][0];
      expect(input.schedule.kind).toBe("once");
      expect(input.schedule.at).toBeGreaterThanOrEqual(before);
    } finally {
      await client.close();
    }
  });

  it("refuses to schedule when the token disallows it", async () => {
    const token = mcpSessionTokens.sign({
      cwd: "/home/user/project",
      canScheduleSessions: false,
    });
    const client = await connectClient(token);
    try {
      const result = await client.callTool({
        name: "create_scheduled_session",
        arguments: {
          schedule: { kind: "immediate" },
          config: { type: "claude", cwd: "/home/user/project" },
        },
      });
      expect(result.isError).toBe(true);
      expect(createScheduledSession).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("refuses to schedule without a token", async () => {
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: "create_scheduled_session",
        arguments: {
          schedule: { kind: "immediate" },
          config: { type: "claude", cwd: "/home/user/project" },
        },
      });
      expect(result.isError).toBe(true);
      expect(createScheduledSession).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("updates an agent-created entry as a re-approval proposal", async () => {
    getScheduledSession.mockReturnValueOnce({
      id: "sched-1",
      createdBy: "agent",
      enabled: true,
    });
    const token = mcpSessionTokens.sign({
      cwd: "/home/user/project",
      canScheduleSessions: true,
    });
    const client = await connectClient(token);
    try {
      const result = await client.callTool({
        name: "update_scheduled_session",
        arguments: {
          id: "sched-1",
          schedule: { kind: "recurring", cron: "0 8 * * *" },
          config: { type: "claude", cwd: "/home/user/project" },
        },
      });
      expect(result.isError).toBeFalsy();
      expect(updateScheduledSession).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "sched-1",
          schedule: { kind: "recurring", cron: "0 8 * * *" },
          editedBy: "agent",
        }),
      );
      const [content] = result.content as [{ type: string; text: string }];
      expect(JSON.parse(content.text)).toMatchObject({
        id: "sched-1",
        status: "pending-approval",
      });
    } finally {
      await client.close();
    }
  });

  it("refuses to update user-created entries", async () => {
    getScheduledSession.mockReturnValueOnce({
      id: "sched-1",
      createdBy: "user",
      enabled: true,
    });
    const token = mcpSessionTokens.sign({
      cwd: "/home/user/project",
      canScheduleSessions: true,
    });
    const client = await connectClient(token);
    try {
      const result = await client.callTool({
        name: "update_scheduled_session",
        arguments: {
          id: "sched-1",
          schedule: { kind: "immediate" },
          config: { type: "claude", cwd: "/home/user/project" },
        },
      });
      expect(result.isError).toBe(true);
      expect(updateScheduledSession).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("refuses to update when the token disallows scheduling", async () => {
    const token = mcpSessionTokens.sign({
      cwd: "/home/user/project",
      canScheduleSessions: false,
    });
    const client = await connectClient(token);
    try {
      const result = await client.callTool({
        name: "update_scheduled_session",
        arguments: {
          id: "sched-1",
          schedule: { kind: "immediate" },
          config: { type: "claude", cwd: "/home/user/project" },
        },
      });
      expect(result.isError).toBe(true);
      expect(updateScheduledSession).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("deletes an agent-created entry that never ran", async () => {
    getScheduledSession.mockReturnValueOnce({
      id: "sched-1",
      createdBy: "agent",
      enabled: false,
      lastRunAt: undefined,
    });
    const token = mcpSessionTokens.sign({
      cwd: "/home/user/project",
      canScheduleSessions: true,
    });
    const client = await connectClient(token);
    try {
      const result = await client.callTool({
        name: "delete_scheduled_session",
        arguments: { id: "sched-1" },
      });
      expect(result.isError).toBeFalsy();
      expect(deleteScheduledSession).toHaveBeenCalledWith("sched-1");
    } finally {
      await client.close();
    }
  });

  it.each([
    ["user-created", { createdBy: "user", enabled: false }],
    ["approved", { createdBy: "agent", enabled: true }],
    ["already ran", { createdBy: "agent", enabled: false, lastRunAt: 123 }],
  ])("refuses to delete %s entries", async (_label, entry) => {
    getScheduledSession.mockReturnValueOnce({ id: "sched-1", ...entry });
    const token = mcpSessionTokens.sign({
      cwd: "/home/user/project",
      canScheduleSessions: true,
    });
    const client = await connectClient(token);
    try {
      const result = await client.callTool({
        name: "delete_scheduled_session",
        arguments: { id: "sched-1" },
      });
      expect(result.isError).toBe(true);
      expect(deleteScheduledSession).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("lists scheduled sessions", async () => {
    listScheduledSessions.mockReturnValueOnce([
      {
        id: "sched-1",
        name: "Nightly",
        createdBy: "agent",
        enabled: false,
        schedule: { kind: "recurring", cron: "0 9 * * *" },
        config: {
          type: "claude",
          cwd: "/home/user/project",
          initialPrompt: "triage",
        },
        createdAt: 1,
      },
      // biome-ignore lint/suspicious/noExplicitAny: partial fixture
    ] as any);
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: "list_scheduled_sessions",
        arguments: {},
      });
      const [content] = result.content as [{ type: string; text: string }];
      expect(JSON.parse(content.text).scheduledSessions).toEqual([
        {
          id: "sched-1",
          name: "Nightly",
          createdBy: "agent",
          enabled: false,
          needsApproval: false,
          schedule: { kind: "recurring", cron: "0 9 * * *" },
          sessionType: "claude",
          cwd: "/home/user/project",
          initialPrompt: "triage",
        },
      ]);
    } finally {
      await client.close();
    }
  });

  it("falls back to a null cwd for a forged token", async () => {
    const forged = new McpSessionTokens().sign({
      cwd: "/home/user/project",
      canScheduleSessions: true,
    });
    const client = await connectClient(forged);
    try {
      await client.callTool({ name: "list_skills", arguments: {} });
      expect(listSkillsForPath).toHaveBeenCalledWith(null);
    } finally {
      await client.close();
    }
  });
});
