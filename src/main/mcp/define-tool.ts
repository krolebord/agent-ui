import type {
  McpServer,
  ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { Services } from "../create-services";
import type { McpRequestContext } from "./session-token";

export interface McpTool {
  name: string;
  register(
    server: McpServer,
    services: Services,
    context: McpRequestContext,
  ): void;
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function defineMcpTool<Shape extends z.ZodRawShape>(tool: {
  name: string;
  description: string;
  inputSchema: Shape;
  annotations?: ToolAnnotations;
  /** Checked per MCP request, which builds a fresh server each time. */
  isAvailable?: (services: Services, context: McpRequestContext) => boolean;
  handler: (
    input: z.output<z.ZodObject<Shape>>,
    services: Services,
    context: McpRequestContext,
  ) => CallToolResult | Promise<CallToolResult>;
}): McpTool {
  return {
    name: tool.name,
    register(server, services, context) {
      if (tool.isAvailable && !tool.isAvailable(services, context)) {
        return;
      }
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        },
        ((input: z.output<z.ZodObject<Shape>>) =>
          tool.handler(
            input,
            services,
            context,
          )) as unknown as ToolCallback<Shape>,
      );
    },
  };
}
