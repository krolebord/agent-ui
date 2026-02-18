import { defineServiceState } from "@shared/service-state";
import { z } from "zod";
import { defineStatePersistence } from "../persistence-orchestrator";
import { claudeLocalTerminalSessionSchema } from "../session-service";
import { localTerminalSessionSchema } from "./local-terminal.session";
import { ralphLoopSessionSchema } from "./ralph-loop.session";

const sessionSchema = z.discriminatedUnion("type", [
  claudeLocalTerminalSessionSchema,
  localTerminalSessionSchema,
  ralphLoopSessionSchema,
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
