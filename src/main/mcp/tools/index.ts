import type { McpTool } from "../define-tool";
import { createScheduledSessionTool } from "./create-scheduled-session";
import { deleteScheduledSessionTool } from "./delete-scheduled-session";
import { listScheduledSessionsTool } from "./list-scheduled-sessions";
import { listSkillsTool } from "./list-skills";
import { updateScheduledSessionTool } from "./update-scheduled-session";

export const mcpTools: McpTool[] = [
  listSkillsTool,
  createScheduledSessionTool,
  updateScheduledSessionTool,
  deleteScheduledSessionTool,
  listScheduledSessionsTool,
];
