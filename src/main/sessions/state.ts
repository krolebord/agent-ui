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

export const defineSessionServiceState = () =>
  defineServiceState({
    key: "sessions",
    defaults: {} as Record<string, Session>,
  });

export const defineSessionStatePersistence = (state: SessionServiceState) =>
  defineStatePersistence({
    serviceState: state,
    schema: z.record(z.string(), sessionSchema),
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
