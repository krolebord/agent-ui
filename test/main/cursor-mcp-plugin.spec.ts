import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureCursorMcpPlugin } from "../../src/main/cursor-mcp-plugin";

describe("ensureCursorMcpPlugin", () => {
  let userDataPath: string;

  beforeEach(async () => {
    userDataPath = await mkdtemp(path.join(os.tmpdir(), "cursor-mcp-plugin-"));
  });

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true });
  });

  it("writes a plugin that reads the MCP URL from the environment", async () => {
    const pluginRoot = await ensureCursorMcpPlugin(userDataPath);
    await ensureCursorMcpPlugin(userDataPath);

    expect(pluginRoot).toBe(path.join(userDataPath, "cursor-mcp-plugin"));
    expect(
      JSON.parse(
        await readFile(
          path.join(pluginRoot, ".cursor-plugin", "plugin.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ name: "agent-ui", mcpServers: "mcp.json" });
    expect(
      JSON.parse(await readFile(path.join(pluginRoot, "mcp.json"), "utf8")),
    ).toEqual({
      mcpServers: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Cursor config variable
        "agent-ui": { url: "${env:AGENT_UI_MCP_URL}" },
      },
    });
  });
});
