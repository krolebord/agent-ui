import type { McpTool } from "../define-tool";
import { helloWorldTool } from "./hello-world";
import { listSkillsTool } from "./list-skills";

export const mcpTools: McpTool[] = [helloWorldTool, listSkillsTool];
