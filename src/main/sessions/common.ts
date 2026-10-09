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
  status: sessionStatusSchema,
  turn: z
    .object({
      id: z.string(),
      status: z.enum([
        "running",
        "awaiting_approval",
        "completed",
        "interrupted",
      ]),
    })
    .optional(),
  warningMessage: z.string().optional(),
  errorMessage: z.string().optional(),
  settledAt: z.number().optional(),
  settledOverride: z.enum(["settled", "active"]).optional(),
  snoozedUntil: z.number().optional(),
  snoozedAt: z.number().optional(),
});

export function setSessionStatus(
  session: Pick<z.infer<typeof commonSessionSchema>, "status" | "turn">,
  status: SessionStatus,
): void {
  const turn = session.turn;
  if (status === "running") {
    session.turn = {
      id:
        turn?.status === "running" || turn?.status === "awaiting_approval"
          ? turn.id
          : randomUUID(),
      status: "running",
    };
  } else if (
    turn?.status === "running" ||
    turn?.status === "awaiting_approval"
  ) {
    session.turn = {
      id: turn.id,
      status:
        status === "awaiting_approval"
          ? "awaiting_approval"
          : status === "awaiting_user_response"
            ? "completed"
            : "interrupted",
    };
  }
  session.status = status;
}
