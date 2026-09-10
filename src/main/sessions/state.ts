import { defineServiceState } from "@shared/service-state";
import { z } from "zod";
import { defineStatePersistence } from "../persistence-orchestrator";
import { claudeLocalTerminalSessionSchema } from "../session-service";
import { codexLocalTerminalSessionSchema } from "./codex.session";
import { cursorAgentSessionSchema } from "./cursor-agent.session";
import { localTerminalSessionSchema } from "./local-terminal.session";
import { worktreeSetupSessionSchema } from "./worktree-setup.session";

const sessionSchema = z.discriminatedUnion("type", [
  claudeLocalTerminalSessionSchema,
  localTerminalSessionSchema,
  codexLocalTerminalSessionSchema,
  cursorAgentSessionSchema,
  worktreeSetupSessionSchema,
]);
export type Session = z.infer<typeof sessionSchema>;

const runtimeSessionFields = {
  status: true,
  warningMessage: true,
  errorMessage: true,
} as const;

const persistedSessionSchema = z.discriminatedUnion("type", [
  claudeLocalTerminalSessionSchema.omit(runtimeSessionFields),
  localTerminalSessionSchema.omit(runtimeSessionFields),
  codexLocalTerminalSessionSchema.omit(runtimeSessionFields),
  cursorAgentSessionSchema.omit(runtimeSessionFields),
  worktreeSetupSessionSchema.omit(runtimeSessionFields),
]);
type PersistedSession = z.infer<typeof persistedSessionSchema>;

const WORKTREE_SETUP_INTERRUPTED_MESSAGE =
  "Setup was interrupted when the app quit.";

function hydrateSession(persisted: PersistedSession): Session {
  if (persisted.type === "worktree-setup") {
    return {
      ...persisted,
      status: "error",
      errorMessage: WORKTREE_SETUP_INTERRUPTED_MESSAGE,
      steps: persisted.steps.map((step) =>
        step.status === "running"
          ? {
              ...step,
              status: "error" as const,
              errorMessage: WORKTREE_SETUP_INTERRUPTED_MESSAGE,
            }
          : step,
      ),
    };
  }

  return { ...persisted, status: "stopped" };
}

export const defineSessionServiceState = () =>
  defineServiceState({
    key: "sessions",
    defaults: {} as Record<string, Session>,
  });

export const defineSessionStatePersistence = (state: SessionServiceState) =>
  defineStatePersistence({
    serviceState: state,
    schema: z.record(z.string(), persistedSessionSchema),
    fromPersisted: (_defaults, persisted) =>
      Object.fromEntries(
        Object.entries(persisted).map(([sessionId, session]) => [
          sessionId,
          hydrateSession(session),
        ]),
      ),
  });
export type SessionServiceState = ReturnType<typeof defineSessionServiceState>;

export function removeLegacyLocalTerminalSessions(
  state: SessionServiceState,
): number {
  const localTerminalIds = Object.entries(state.state)
    .filter(([, session]) => session.type === "local-terminal")
    .map(([sessionId]) => sessionId);

  if (localTerminalIds.length === 0) {
    return 0;
  }

  state.updateState((sessions) => {
    for (const sessionId of localTerminalIds) {
      delete sessions[sessionId];
    }
  });

  return localTerminalIds.length;
}
