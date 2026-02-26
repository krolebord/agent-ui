import { z } from "zod";
import { appSettingsRouter } from "./app-settings";
import { fsRouter } from "./fs.router";
import { procedure } from "./orpc";
import { projectsRouter } from "./project-service";
import { claudeSessionsRouter } from "./session-service";
import { codexSessionsRouter } from "./sessions/codex.session";
import { cursorAgentSessionsRouter } from "./sessions/cursor-agent.session";
import { localTerminalRouter } from "./sessions/local-terminal.session";
import { ralphLoopRouter } from "./sessions/ralph-loop.session";
import { stateSyncRouter } from "./state-orchestrator";

const sessionsRouter = {
  markSeen: procedure
    .input(z.object({ sessionId: z.string() }))
    .handler(async ({ input, context }) => {
      context.sessions.state.updateState((state) => {
        const session = state[input.sessionId];
        if (session?.status === "awaiting_user_response") {
          session.status = "idle";
        }
      });
    }),
  markUnseen: procedure
    .input(z.object({ sessionId: z.string() }))
    .handler(async ({ input, context }) => {
      context.sessions.state.updateState((state) => {
        const session = state[input.sessionId];
        if (session) {
          session.status = "awaiting_user_response";
        }
      });
    }),
  localClaude: claudeSessionsRouter,
  localTerminal: localTerminalRouter,
  ralphLoop: ralphLoopRouter,
  codex: codexSessionsRouter,
  cursorAgent: cursorAgentSessionsRouter,
};

export const orpcRouter = {
  appSettings: appSettingsRouter,
  projects: projectsRouter,
  fs: fsRouter,
  stateSync: stateSyncRouter,
  sessions: sessionsRouter,
};
