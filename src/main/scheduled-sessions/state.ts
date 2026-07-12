import { defineServiceState } from "@shared/service-state";
import { z } from "zod";
import { defineStatePersistence } from "../persistence-orchestrator";
import { startClaudeSessionSchema } from "../session-service";
import { startCodexSessionSchema } from "../sessions/codex.session";
import { startCursorAgentSessionSchema } from "../sessions/cursor-agent.session";

export const scheduleSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("once"),
    at: z.number(),
  }),
  z.object({
    kind: z.literal("recurring"),
    cron: z.string().trim().min(1),
  }),
]);
export type ScheduleSpec = z.infer<typeof scheduleSpecSchema>;

const claudeScheduledConfigSchema = startClaudeSessionSchema
  .omit({ cols: true, rows: true, resumeSessionId: true, forkSessionId: true })
  .extend({ type: z.literal("claude") });
const codexScheduledConfigSchema = startCodexSessionSchema
  .omit({ cols: true, rows: true })
  .extend({ type: z.literal("codex") });
const cursorScheduledConfigSchema = startCursorAgentSessionSchema
  .omit({ cols: true, rows: true })
  .extend({ type: z.literal("cursorAgent") });

export const scheduledSessionConfigSchema = z.discriminatedUnion("type", [
  claudeScheduledConfigSchema,
  codexScheduledConfigSchema,
  cursorScheduledConfigSchema,
]);
export type ScheduledSessionConfig = z.infer<
  typeof scheduledSessionConfigSchema
>;

export const scheduledSessionSchema = z.object({
  id: z.string(),
  name: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  createdAt: z.number(),
  enabled: z.boolean(),
  schedule: scheduleSpecSchema,
  config: scheduledSessionConfigSchema,
  nextRunAt: z.number().optional(),
  lastRunAt: z.number().optional(),
  lastRunSessionId: z.string().optional(),
  lastError: z.string().optional(),
});
export type ScheduledSession = z.infer<typeof scheduledSessionSchema>;

export const defineScheduledSessionsState = () =>
  defineServiceState({
    key: "scheduledSessions",
    defaults: {} as Record<string, ScheduledSession>,
  });
export type ScheduledSessionsState = ReturnType<
  typeof defineScheduledSessionsState
>;

export const defineScheduledSessionsPersistence = (
  state: ScheduledSessionsState,
) =>
  defineStatePersistence({
    serviceState: state,
    schema: z.record(z.string(), scheduledSessionSchema),
  });
