import { z } from "zod";

export const codexPermissionModeSchema = z.enum([
  "default",
  "full-auto",
  "yolo",
]);

export type CodexPermissionMode = z.infer<typeof codexPermissionModeSchema>;

export const codexFastModeSchema = z
  .union([z.enum(["default", "fast", "off"]), z.boolean()])
  .transform((value) =>
    value === true ? "fast" : value === false ? "off" : value,
  );

export type CodexFastMode = z.infer<typeof codexFastModeSchema>;

export const codexModelReasoningEffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

export type CodexModelReasoningEffort = z.infer<
  typeof codexModelReasoningEffortSchema
>;
