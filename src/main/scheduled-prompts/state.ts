import {
  scheduledPromptInputSchema,
  scheduledPromptScheduleSchema,
} from "@shared/scheduled-prompts";
import { defineServiceState } from "@shared/service-state";
import { z } from "zod";
import { defineStatePersistence } from "../persistence-orchestrator";

export const scheduledPromptSchema = scheduledPromptInputSchema.extend({
  schedule: scheduledPromptScheduleSchema,
  id: z.string(),
  createdAt: z.number(),
  status: z.enum(["pending", "sending", "sent", "failed", "uncertain"]),
  sentAt: z.number().optional(),
  message: z.string().optional(),
});
export type ScheduledPrompt = z.infer<typeof scheduledPromptSchema>;

export const defineScheduledPromptsState = () =>
  defineServiceState<"scheduledPrompts", Record<string, ScheduledPrompt>>({
    key: "scheduledPrompts",
    defaults: {},
  });
export type ScheduledPromptsState = ReturnType<
  typeof defineScheduledPromptsState
>;

export const defineScheduledPromptsPersistence = (
  state: ScheduledPromptsState,
) =>
  defineStatePersistence({
    serviceState: state,
    schema: z.record(z.string(), scheduledPromptSchema),
  });
