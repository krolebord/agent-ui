import { scheduledPromptInputSchema } from "@shared/scheduled-prompts";
import { z } from "zod";
import { procedure } from "../orpc";

export const scheduledPromptsRouter = {
  create: procedure
    .input(scheduledPromptInputSchema)
    .handler(({ input, context }) =>
      context.scheduledPromptsService.create(input),
    ),
  update: procedure
    .input(scheduledPromptInputSchema.extend({ id: z.string() }))
    .handler(({ input, context }) =>
      context.scheduledPromptsService.update(input),
    ),
  delete: procedure
    .input(z.object({ id: z.string() }))
    .handler(({ input, context }) =>
      context.scheduledPromptsService.delete(input.id),
    ),
  sendNow: procedure
    .input(z.object({ id: z.string() }))
    .handler(({ input, context }) =>
      context.scheduledPromptsService.sendNow(input.id),
    ),
};
