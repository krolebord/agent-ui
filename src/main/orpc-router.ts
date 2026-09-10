import { call } from "@orpc/server";
import {
  canSettleSession,
  canSnoozeSession,
  isSessionSettled,
} from "@shared/session-lifecycle";
import { z } from "zod";
import { appSettingsRouter } from "./app-settings";
import { artifactsRouter } from "./artifacts-service";
import { claudeAccountsRouter } from "./claude-accounts";
import { codexAccountsRouter } from "./codex-accounts";
import { fsRouter } from "./fs.router";
import { globalInstructionsRouter } from "./global-instructions-service";
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
import { usageRouter } from "./usage-tracking";

export const sessionsRouter = {
  markSeen: procedure
    .input(
      z.object({
        sessionId: z.string(),
        visiting: z.boolean().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      context.sessions.state.updateState((state) => {
        const session = state[input.sessionId];
        if (!session) {
          return;
        }
        if (session.status === "awaiting_user_response") {
          session.status = "idle";
        }
        if (input.visiting) {
          delete session.snoozedUntil;
          delete session.snoozedAt;
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
      if (!session || !canSettleSession(session)) {
        return;
      }
      const sessionType = session.type;

      let didSettle = false;
      context.sessions.state.updateState((state) => {
        const current = state[input.sessionId];
        if (!current || !canSettleSession(current)) {
          return;
        }
        current.settledOverride = "settled";
        current.settledAt = Date.now();
        if (current.status === "awaiting_user_response") {
          current.status = "idle";
        }
        didSettle = true;
      });

      if (!didSettle) {
        return;
      }

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
    }),
  unsettle: procedure
    .input(
      z.object({
        sessionId: z.string(),
        cols: z.number().optional(),
        rows: z.number().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const session = context.sessions.state.state[input.sessionId];
      if (!session || !isSessionSettled(session)) {
        return;
      }
      const sessionType = session.type;

      let didUnsettle = false;
      context.sessions.state.updateState((state) => {
        const current = state[input.sessionId];
        if (!current || !isSessionSettled(current)) {
          return;
        }
        delete current.settledOverride;
        delete current.settledAt;
        const now = Date.now();
        current.createdAt = now;
        current.lastActivityAt = now;
        didUnsettle = true;
      });

      if (!didUnsettle) {
        return;
      }

      switch (sessionType) {
        case "claude-local-terminal":
          await call(
            claudeSessionsRouter.resumeSession,
            {
              sessionId: input.sessionId,
              cols: input.cols,
              rows: input.rows,
            },
            { context },
          );
          break;
        case "local-terminal":
          await call(
            localTerminalRouter.resumeSession,
            {
              sessionId: input.sessionId,
              cols: input.cols,
              rows: input.rows,
            },
            { context },
          );
          break;
        case "codex-local-terminal":
          await call(
            codexSessionsRouter.resumeSession,
            {
              sessionId: input.sessionId,
              cols: input.cols,
              rows: input.rows,
            },
            { context },
          );
          break;
        case "cursor-agent":
          await call(
            cursorAgentSessionsRouter.resumeSession,
            {
              sessionId: input.sessionId,
              cols: input.cols,
              rows: input.rows,
            },
            { context },
          );
          break;
        case "worktree-setup":
          break;
        default: {
          const exhaustiveCheck: never = sessionType;
          return exhaustiveCheck;
        }
      }
    }),
  snooze: procedure
    .input(z.object({ sessionId: z.string(), snoozedUntil: z.number() }))
    .handler(async ({ input, context }) => {
      const session = context.sessions.state.state[input.sessionId];
      if (!session || !canSnoozeSession(session)) {
        return;
      }
      const now = Date.now();
      if (!Number.isFinite(input.snoozedUntil) || input.snoozedUntil <= now) {
        return;
      }
      const sessionType = session.type;

      let didSnooze = false;
      context.sessions.state.updateState((state) => {
        const current = state[input.sessionId];
        if (!current || !canSnoozeSession(current)) {
          return;
        }
        if (
          !Number.isFinite(input.snoozedUntil) ||
          input.snoozedUntil <= Date.now()
        ) {
          return;
        }
        current.snoozedUntil = input.snoozedUntil;
        current.snoozedAt = Date.now();
        if (current.status === "awaiting_user_response") {
          current.status = "idle";
        }
        delete current.settledOverride;
        delete current.settledAt;
        didSnooze = true;
      });

      if (!didSnooze) {
        return;
      }

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
    }),
  unsnooze: procedure
    .input(z.object({ sessionId: z.string() }))
    .handler(async ({ input, context }) => {
      context.sessions.state.updateState((state) => {
        const session = state[input.sessionId];
        if (!session) {
          return;
        }
        delete session.snoozedUntil;
        delete session.snoozedAt;
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
  artifacts: artifactsRouter,
  appSettings: appSettingsRouter,
  claudeAccounts: claudeAccountsRouter,
  codexAccounts: codexAccountsRouter,
  projects: projectsRouter,
  projectTerminals: projectTerminalsRouter,
  terminals: terminalsRouter,
  fs: fsRouter,
  stateSync: stateSyncRouter,
  sessions: sessionsRouter,
  skills: skillsRouter,
  globalInstructions: globalInstructionsRouter,
  scheduledSessions: scheduledSessionsRouter,
  usage: usageRouter,
};
