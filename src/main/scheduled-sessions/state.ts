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

// mcpCanScheduleSessions is omitted so a stored config can never grant the
// spawned session scheduling rights; the runner derives it from createdBy.
const claudeScheduledConfigSchema = startClaudeSessionSchema
  .omit({
    cols: true,
    rows: true,
    resumeSessionId: true,
    forkSessionId: true,
    mcpCanScheduleSessions: true,
  })
  .extend({ type: z.literal("claude") });
const codexScheduledConfigSchema = startCodexSessionSchema
  .omit({ cols: true, rows: true, mcpCanScheduleSessions: true })
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
  // Absent means "user" (entries persisted before agent-created schedules).
  createdBy: z.enum(["user", "agent"]).optional(),
  // True while an agent-proposed create or edit awaits user review. Cleared
  // when the user enables the entry or edits it themselves.
  needsApproval: z.boolean().optional(),
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
