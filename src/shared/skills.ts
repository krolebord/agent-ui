import { z } from "zod";

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export const skillNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    SKILL_NAME_PATTERN,
    "Use lowercase letters, numbers, hyphens and underscores",
  );

export const skillScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("global") }),
  z.object({ type: z.literal("project"), projectPath: z.string().min(1) }),
]);

export type SkillScope = z.infer<typeof skillScopeSchema>;

export interface SkillEntry {
  name: string;
  scope: SkillScope;
  description: string;
  body: string;
  userInvokeOnly: boolean;
  managedBy: "app" | "builtin" | null;
  dirPath: string;
  hasExtraFiles: boolean;
  updatedAt: number;
}

export function skillEntryKey(entry: Pick<SkillEntry, "dirPath">): string {
  return entry.dirPath;
}
