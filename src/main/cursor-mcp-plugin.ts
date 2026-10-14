import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { MCP_SERVER_NAME } from "./mcp/client-config";

export const CURSOR_MCP_URL_ENV = "AGENT_UI_MCP_URL";

export async function ensureCursorMcpPlugin(
  userDataPath: string,
): Promise<string> {
  const pluginRoot = path.join(userDataPath, "cursor-mcp-plugin");
  const manifestDir = path.join(pluginRoot, ".cursor-plugin");
  await mkdir(manifestDir, { recursive: true });

  await writeFile(
    path.join(manifestDir, "plugin.json"),
    `${JSON.stringify(
      {
        name: MCP_SERVER_NAME,
        version: "1.0.0",
        description: "Agent UI tools for this session.",
        mcpServers: "mcp.json",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(pluginRoot, "mcp.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          [MCP_SERVER_NAME]: { url: `\${env:${CURSOR_MCP_URL_ENV}}` },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return pluginRoot;
}
