export const MCP_SERVER_NAME = "agent-ui";

// Value for Claude's --mcp-config flag, which accepts inline JSON.
export function buildClaudeMcpConfig(mcpServerUrl: string): string {
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: { type: "http", url: mcpServerUrl },
    },
  });
}

// Value for Codex's -c/--config override; the value part is parsed as TOML,
// so the URL needs explicit string quotes.
export function buildCodexMcpConfigOverride(mcpServerUrl: string): string {
  return `mcp_servers.${MCP_SERVER_NAME}.url="${mcpServerUrl}"`;
}
