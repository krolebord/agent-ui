export const MCP_SERVER_NAME = "agent-ui";

export function buildClaudeMcpConfig(mcpServerUrl: string): string {
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: { type: "http", url: mcpServerUrl },
    },
  });
}

export function buildCodexMcpConfigOverride(mcpServerUrl: string): string {
  return `mcp_servers.${MCP_SERVER_NAME}.url="${mcpServerUrl}"`;
}
