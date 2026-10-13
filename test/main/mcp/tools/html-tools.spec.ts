import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
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
import type { Services } from "../../../../src/main/create-services";
import {
  handleMcpHttpRequest,
  MCP_PATH,
} from "../../../../src/main/mcp/server";
import { McpSessionTokens } from "../../../../src/main/mcp/session-token";
import { AgentBrowserError } from "../../../../src/main/visuals/agent-browser";
import {
  type HtmlPreviewResult,
  HtmlPreviewUnavailableError,
} from "../../../../src/main/visuals/html-preview";

const mcpSessionTokens = new McpSessionTokens();
const agentBrowser = { isUnavailable: false };
const preview =
  vi.fn<
    (input: { html: string; width: number }) => Promise<HtmlPreviewResult>
  >();
const publishVisual = vi.fn();
const services = {
  mcpSessionTokens,
  agentBrowser,
  htmlPreviewer: { preview },
  artifactsService: { publishVisual },
  sessionMemory: { isEnabled: () => false },
} as unknown as Services;

const previewResult: HtmlPreviewResult = {
  width: 728,
  contentHeight: 420,
  capturedHeight: 420,
  consoleMessages: [{ level: "error", text: "boom" }],
  errors: ["ReferenceError: x is not defined"],
  screenshotPath: "/data/visual-previews/shot.png",
  screenshotBase64: "iVBORw0KGgo=",
};

type ToolResult = {
  content: Array<{ type: string; text?: string; data?: string }>;
  isError?: boolean;
};

describe("html MCP tools", () => {
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
    agentBrowser.isUnavailable = false;
    preview.mockReset();
    preview.mockResolvedValue(previewResult);
    publishVisual.mockReset();
  });

  async function withClient<T>(
    token: string | undefined,
    run: (client: Client) => Promise<T>,
  ): Promise<T> {
    const url = token ? `${baseUrl}?token=${token}` : baseUrl;
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    try {
      return await run(client);
    } finally {
      await client.close();
    }
  }

  const sessionToken = () =>
    mcpSessionTokens.sign({
      sessionId: "session-1",
      cwd: "/home/user/project",
      canScheduleSessions: false,
    });

  const callTool = (
    name: string,
    args: Record<string, unknown>,
    token?: string,
  ) =>
    withClient(
      token,
      async (client) =>
        (await client.callTool({ name, arguments: args })) as ToolResult,
    );

  it("offers html_preview only while agent-browser is available", async () => {
    const listNames = () =>
      withClient(undefined, async (client) =>
        (await client.listTools()).tools.map((tool) => tool.name),
      );

    expect(await listNames()).toEqual(
      expect.arrayContaining(["html_preview", "html_render"]),
    );

    agentBrowser.isUnavailable = true;
    const names = await listNames();
    expect(names).toContain("html_render");
    expect(names).not.toContain("html_preview");
  });

  it("previews the prepared page and returns the screenshot with diagnostics", async () => {
    const result = await callTool("html_preview", {
      html: "<p>Chart</p>",
      width: 5000,
    });

    expect(preview).toHaveBeenCalledTimes(1);
    const input = preview.mock.calls[0]?.[0];
    expect(input?.width).toBe(1600);
    expect(input?.html.startsWith("<!doctype html>")).toBe(true);
    expect(input?.html).toContain('<style id="agent-ui-theme">');

    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toEqual({
      type: "image",
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
    });
    expect(JSON.parse(result.content[1]?.text ?? "")).toEqual({
      width: 728,
      contentHeight: 420,
      capturedHeight: 420,
      consoleMessages: [{ level: "error", text: "boom" }],
      errors: ["ReferenceError: x is not defined"],
      screenshotPath: "/data/visual-previews/shot.png",
    });
  });

  it("uses the default width and reports missing images without failing", async () => {
    const result = await callTool("html_preview", {
      html: '<img src="/definitely/missing/shot.png">',
    });

    expect(preview.mock.calls[0]?.[0].width).toBe(728);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[1]?.text ?? "")).toMatchObject({
      missingImages: ["/definitely/missing/shot.png"],
    });
  });

  it.each([
    new HtmlPreviewUnavailableError("Chrome's sandbox can't start"),
    new AgentBrowserError("agent-browser timed out"),
  ])("returns preview failures to the agent: %s", async (error) => {
    preview.mockRejectedValueOnce(error);

    const result = await callTool("html_preview", { html: "<p>x</p>" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(error.message);
  });

  it("publishes a page as a visual artifact of the calling session", async () => {
    publishVisual.mockResolvedValueOnce({ id: "artifact-1", name: "Chart" });

    const result = await callTool(
      "html_render",
      { html: "<p>Chart</p>", title: " Chart ", description: "Weekly" },
      sessionToken(),
    );

    expect(result.isError).toBeFalsy();
    expect(publishVisual).toHaveBeenCalledWith({
      sessionId: "session-1",
      html: expect.stringContaining('<style id="agent-ui-theme">'),
      title: "Chart",
      description: "Weekly",
    });
    expect(JSON.parse(result.content[0]?.text ?? "")).toMatchObject({
      artifactId: "artifact-1",
      name: "Chart",
    });
  });

  it("refuses to publish outside a managed session", async () => {
    const result = await callTool("html_render", {
      html: "<p>Chart</p>",
      title: "Chart",
    });

    expect(result.isError).toBe(true);
    expect(publishVisual).not.toHaveBeenCalled();
  });

  it("refuses to publish a page with unreadable local images", async () => {
    const result = await callTool(
      "html_render",
      { html: '<img src="/definitely/missing/shot.png">', title: "Chart" },
      sessionToken(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("/definitely/missing/shot.png");
    expect(publishVisual).not.toHaveBeenCalled();
  });

  describe("pages passed by path", () => {
    let projectDir: string;

    beforeAll(async () => {
      projectDir = await mkdtemp(path.join(os.tmpdir(), "html-tools-"));
      await writeFile(path.join(projectDir, "chart.html"), "<p>From file</p>");
      await writeFile(path.join(projectDir, "notes.txt"), "<p>Not a page</p>");
    });

    afterAll(async () => {
      await rm(projectDir, { recursive: true, force: true });
    });

    const projectToken = () =>
      mcpSessionTokens.sign({
        sessionId: "session-1",
        cwd: projectDir,
        canScheduleSessions: false,
      });

    it("previews a file relative to the session working directory", async () => {
      const result = await callTool(
        "html_preview",
        { path: "chart.html" },
        projectToken(),
      );

      expect(result.isError).toBeFalsy();
      expect(preview.mock.calls[0]?.[0].html).toContain("<p>From file</p>");
    });

    it("publishes a file given by absolute path", async () => {
      publishVisual.mockResolvedValueOnce({ id: "artifact-2", name: "Chart" });

      const result = await callTool(
        "html_render",
        { path: path.join(projectDir, "chart.html"), title: "Chart" },
        sessionToken(),
      );

      expect(result.isError).toBeFalsy();
      expect(publishVisual).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining("<p>From file</p>"),
        }),
      );
    });

    it.each([
      [{}, "exactly one of html or path"],
      [{ html: "<p>x</p>", path: "chart.html" }, "exactly one of html or path"],
      [{ path: "notes.txt" }, "not an .html or .htm file"],
      [{ path: "missing.html" }, "does not exist"],
    ])("rejects %j", async (args, message) => {
      const result = await callTool("html_preview", args, projectToken());

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(message);
      expect(preview).not.toHaveBeenCalled();
    });

    it("needs an absolute path without a session working directory", async () => {
      const result = await callTool("html_preview", { path: "chart.html" });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("use an absolute path");
    });
  });
});
