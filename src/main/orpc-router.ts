import { getUsage } from "./claude-usage";
import { fsRouter } from "./fs.router";
import { procedure } from "./orpc";
import { projectsRouter } from "./project-service";
import { claudeSessionsRouter } from "./session-service";
import { stateSyncRouter } from "./state-orchestrator";

export const orpcRouter = {
  getUsage: procedure.handler(getUsage),
  projects: projectsRouter,
  fs: fsRouter,
  stateSync: stateSyncRouter,
  sessions: claudeSessionsRouter,
};
