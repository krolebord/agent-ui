import * as z from "zod";

export const codexLogMessageSchema = z
  .object({
    type: z.string().optional(),
  })
  .passthrough();

export const codexLogEventSchema = z
  .object({
    ts: z.string(),
    dir: z.string(),
    kind: z.string(),
    payload: z
      .object({
        msg: codexLogMessageSchema.optional(),
      })
      .passthrough()
      .optional(),
    variant: z.string().optional(),
  })
  .passthrough();

export type CodexLogEvent = z.infer<typeof codexLogEventSchema>;
