import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Services } from "../create-services";
import log from "../logger";
import type { McpRequestContext } from "./session-token";
import { mcpTools } from "./tools";

export const MCP_PATH = "/mcp";

function createMcpServer(services: Services, context: McpRequestContext) {
  const server = new McpServer({
    name: "agent-ui",
    version: "1.0.0",
  });
  for (const tool of mcpTools) {
    tool.register(server, services, context);
  }
  return server;
}

export async function handleMcpHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  services: Services,
) {
  const requestUrl = new URL(req.url ?? "/", "http://agent-ui.local");
  const context = services.mcpSessionTokens.verify(
    requestUrl.searchParams.get("token"),
  ) ?? { cwd: null, canScheduleSessions: false };

  const server = createMcpServer(services, context);
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
