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

/**
 * Fields the runtime owns, so a restart must never resurrect them: `status` is
 * derived from the PTY (or from the setup runner) whenever a session is live,
 * and the two messages belong to the process that produced them. Omitting them
 * from the persisted schema is what keeps them out of the store, since Zod
 * objects drop unknown keys and the orchestrator writes the parse result.
 */
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

/**
 * No session survives a restart, so hydrated ones start stopped. Worktree setup
 * needs a verdict instead of a reset: its steps are persisted, and the runner
 * executing them died with the app, so the session and whichever step it was
 * part-way through are failures rather than work still in progress.
 */
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
