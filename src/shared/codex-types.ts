import { z } from "zod";

export const codexPermissionModeSchema = z.enum([
  "default",
  "full-auto",
  "yolo",
]);

export type CodexPermissionMode = z.infer<typeof codexPermissionModeSchema>;

export const codexFastModeSchema = z.boolean();

export const codexModelReasoningEffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export type CodexModelReasoningEffort = z.infer<
  typeof codexModelReasoningEffortSchema
>;
