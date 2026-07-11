import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Services } from "../create-services";
import log from "../logger";
import { mcpTools } from "./tools";

export const MCP_PATH = "/mcp";

function createMcpServer(services: Services) {
  const server = new McpServer({
    name: "agent-ui",
    version: "1.0.0",
  });
  for (const tool of mcpTools) {
    tool.register(server, services);
  }
  return server;
}

// Stateless: each HTTP request gets a fresh server + transport pair, torn
// down when the response closes. No session state survives between requests,
// so there is nothing to clean up or re-sync. Switch to a stateful transport
// (sessionIdGenerator + session map) only if we need server-initiated
// notifications.
export async function handleMcpHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  services: Services,
) {
  const server = createMcpServer(services);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    log.error("MCP request failed", { error });
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        }),
      );
    }
  }
}
