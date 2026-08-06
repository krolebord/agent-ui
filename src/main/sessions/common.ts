import { randomUUID } from "node:crypto";
import { z } from "zod";

export function generateUniqueSessionId(): string {
  return randomUUID();
}

export const sessionStatusSchema = z.enum([
  "idle",
  "starting",
  "stopping",
  "running",
  "awaiting_user_response",
  "awaiting_approval",
  "stopped",
  "error",
]);

export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const commonSessionSchema = z.object({
  sessionId: z.string(),
  title: z.string().catch("Claude Session"),
  createdAt: z.number().default(Date.now()),
  lastActivityAt: z.number().default(Date.now()),
  // Runtime-owned, not persisted: see `runtimeSessionFields` in ./state.
  status: sessionStatusSchema,
  warningMessage: z.string().optional(),
  errorMessage: z.string().optional(),
  // Inbox sidebar lifecycle. Absent means "active"; see
  // @shared/session-lifecycle for how the pair resolves (settledAt doubles as
  // the anchor that lets later activity un-settle a session on its own).
  settledAt: z.number().optional(),
  settledOverride: z.enum(["settled", "active"]).optional(),
  // Snooze: hidden until `snoozedUntil` passes, or until the session reaches a
  // conclusion. `snoozedAt` is the anchor that separates "already seen when
  // parked" from "happened since". Both survive the wake so the row can show a
  // Woke marker; visiting the session clears them.
  snoozedUntil: z.number().optional(),
  snoozedAt: z.number().optional(),
  // Terminal scrollback lives in the `session_buffers` SQLite table.
});
