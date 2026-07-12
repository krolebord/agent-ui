import { z } from "zod";
import { procedure } from "../orpc";
import { scheduledSessionConfigSchema, scheduleSpecSchema } from "./state";

const createScheduledSessionSchema = z.object({
  name: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  schedule: scheduleSpecSchema,
  config: scheduledSessionConfigSchema,
});

export const scheduledSessionsRouter = {
  create: procedure
    .input(createScheduledSessionSchema)
    .handler(async ({ input, context }) => {
      const entry = context.scheduledSessionsService.create(input);
      return { id: entry.id };
    }),
  delete: procedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) => {
      context.scheduledSessionsService.delete(input.id);
    }),
  setEnabled: procedure
    .input(z.object({ id: z.string(), enabled: z.boolean() }))
    .handler(async ({ input, context }) => {
      context.scheduledSessionsService.setEnabled(input.id, input.enabled);
    }),
  runNow: procedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) => {
      await context.scheduledSessionsService.runNow(input.id);
    }),
};
