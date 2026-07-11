import { z } from "zod";
import { defineMcpTool, textResult } from "../define-tool";

export const helloWorldTool = defineMcpTool({
  name: "hello_world",
  description:
    "Verifies the connection to Agent UI. Greets the caller by name.",
  inputSchema: {
    name: z.string().trim().min(1).optional().describe("Name to greet"),
  },
  handler: (input) => {
    return textResult(
      `Hello, ${input.name ?? "world"}! Agent UI is up and reachable over MCP.`,
    );
  },
});
