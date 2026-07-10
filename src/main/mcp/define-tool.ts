import type {
  McpServer,
  ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { Services } from "../create-services";

export interface McpTool {
  name: string;
  register(server: McpServer, services: Services): void;
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function defineMcpTool<Shape extends z.ZodRawShape>(tool: {
  name: string;
  description: string;
  inputSchema: Shape;
  handler: (
    input: z.output<z.ZodObject<Shape>>,
    services: Services,
  ) => CallToolResult | Promise<CallToolResult>;
}): McpTool {
  return {
    name: tool.name,
    register(server, services) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema,
        },
        // The SDK types the callback via a conditional ShapeOutput<Shape>
        // that TypeScript cannot resolve for an unbound generic; the SDK
        // still validates arguments against inputSchema at runtime.
        ((input: z.output<z.ZodObject<Shape>>) =>
          tool.handler(input, services)) as unknown as ToolCallback<Shape>,
      );
    },
  };
}
