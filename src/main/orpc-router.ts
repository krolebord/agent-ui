import { canSettleSession } from "@shared/session-lifecycle";
import { z } from "zod";
import { appSettingsRouter } from "./app-settings";
import { claudeAccountsRouter } from "./claude-accounts";
import { fsRouter } from "./fs.router";
import { moveStoppedSessionToProject } from "./move-stopped-session-to-project";
import { procedure } from "./orpc";
import { projectsRouter } from "./project-service";
import { projectTerminalsRouter } from "./project-terminals";
import { scheduledSessionsRouter } from "./scheduled-sessions/router";
import { claudeSessionsRouter } from "./session-service";
import { codexSessionsRouter } from "./sessions/codex.session";
import { cursorAgentSessionsRouter } from "./sessions/cursor-agent.session";
import { localTerminalRouter } from "./sessions/local-terminal.session";
import { worktreeSetupSessionsRouter } from "./sessions/worktree-setup.session";
import { skillsRouter } from "./skills-service";
import { stateSyncRouter } from "./state-orchestrator";
import { terminalsRouter } from "./terminal-manager";

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
  settle: procedure
    .input(z.object({ sessionId: z.string() }))
    .handler(async ({ input, context }) => {
      const session = context.sessions.state.state[input.sessionId];
      // Silent no-op rather than an error: the row hides the affordance
      // already, so reaching here means a raced click on work that became
      // blocked, and the derived state the caller re-renders from is right
      // either way.
      if (!session || !canSettleSession(session)) {
        return;
      }
      const sessionType = session.type;

      context.sessions.state.updateState((state) => {
        const current = state[input.sessionId];
        if (!current || !canSettleSession(current)) {
          return;
        }
        current.settledOverride = "settled";
        current.settledAt = Date.now();
        // Parking a finished session acknowledges it, exactly like markSeen —
        // otherwise the unread flag would bounce it straight back out.
        if (current.status === "awaiting_user_response") {
          current.status = "idle";
        }
      });

      // Settling frees the live process. Stop after the marker is written so
      // the row is already parked; re-stamp settledAt afterwards so the
      // stop-driven lastActivityAt bump cannot un-settle it.
      switch (sessionType) {
        case "claude-local-terminal":
          await context.sessionsService.stopLiveSession(input.sessionId);
          break;
        case "local-terminal":
          await context.sessions.localTerminal.stopLiveSession(input.sessionId);
          break;
        case "codex-local-terminal":
          await context.sessions.codex.stopLiveSession(input.sessionId);
          break;
        case "cursor-agent":
          await context.sessions.cursorAgent.stopLiveSession(input.sessionId);
          break;
        case "worktree-setup":
          context.sessions.worktreeSetup.cancelSetup(input.sessionId);
          break;
        default: {
          const exhaustiveCheck: never = sessionType;
          return exhaustiveCheck;
        }
      }

      context.sessions.state.updateState((state) => {
        const current = state[input.sessionId];
        if (!current || current.settledOverride !== "settled") {
          return;
        }
        current.settledAt = Date.now();
      });
    }),
  unsettle: procedure
    .input(z.object({ sessionId: z.string() }))
    .handler(async ({ input, context }) => {
      context.sessions.state.updateState((state) => {
        const session = state[input.sessionId];
        if (!session) {
          return;
        }
        delete session.settledOverride;
        delete session.settledAt;
      });
    }),
  moveSessionToProject: procedure
    .input(
      z.object({
        sessionId: z.string().trim().min(1),
        targetProjectPath: z.string().trim().min(1),
      }),
    )
    .handler(async ({ input, context }) => {
      moveStoppedSessionToProject(
        context,
        input.sessionId,
        input.targetProjectPath,
      );
    }),
  localClaude: claudeSessionsRouter,
  localTerminal: localTerminalRouter,
  codex: codexSessionsRouter,
  cursorAgent: cursorAgentSessionsRouter,
  worktreeSetup: worktreeSetupSessionsRouter,
};

export const orpcRouter = {
  appSettings: appSettingsRouter,
  claudeAccounts: claudeAccountsRouter,
  projects: projectsRouter,
  projectTerminals: projectTerminalsRouter,
  terminals: terminalsRouter,
  fs: fsRouter,
  stateSync: stateSyncRouter,
  sessions: sessionsRouter,
  skills: skillsRouter,
  scheduledSessions: scheduledSessionsRouter,
};
