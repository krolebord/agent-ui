import type { McpTool } from "../define-tool";
import { createScheduledSessionTool } from "./create-scheduled-session";
import { deleteScheduledSessionTool } from "./delete-scheduled-session";
import { listPastSessionsTool } from "./list-past-sessions";
import { listScheduledSessionsTool } from "./list-scheduled-sessions";
import { listSkillsTool } from "./list-skills";
import { publishArtifactTool } from "./publish-artifact";
import { readPastSessionTool } from "./read-past-session";
import { searchPastSessionsTool } from "./search-past-sessions";
import { updateScheduledSessionTool } from "./update-scheduled-session";

export const mcpTools: McpTool[] = [
  listSkillsTool,
  publishArtifactTool,
  createScheduledSessionTool,
  updateScheduledSessionTool,
  deleteScheduledSessionTool,
  listScheduledSessionsTool,
  searchPastSessionsTool,
  listPastSessionsTool,
  readPastSessionTool,
];
