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
  status: sessionStatusSchema
    .transform(() => "stopped" as SessionStatus)
    .catch("stopped"),
  warningMessage: z.string().optional(),
  errorMessage: z.string().optional(),
  bufferedOutput: z.string().optional(),
});
