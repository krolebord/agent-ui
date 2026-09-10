import { z } from "zod";

export const globalInstructionSlotSchema = z.enum([
  "common",
  "claude",
  "codex",
]);
export type GlobalInstructionSlot = z.infer<typeof globalInstructionSlotSchema>;

export const globalInstructionHarnessSchema = z.enum(["claude", "codex"]);
export type GlobalInstructionHarness = z.infer<
  typeof globalInstructionHarnessSchema
>;

export const globalInstructionHarnessInfoSchema = z.object({
  target: globalInstructionHarnessSchema,
  displayPath: z.string(),
  absolutePath: z.string(),
  directoryPath: z.string(),
  lastPushedAt: z.number().nullable(),
});
export type GlobalInstructionHarnessInfo = z.infer<
  typeof globalInstructionHarnessInfoSchema
>;

export const globalInstructionsSnapshotSchema = z.object({
  common: z.string(),
  overrides: z.object({
    claude: z.string(),
    codex: z.string(),
  }),
  updatedAt: z.number().nullable(),
  harnesses: z.array(globalInstructionHarnessInfoSchema),
});
export type GlobalInstructionsSnapshot = z.infer<
  typeof globalInstructionsSnapshotSchema
>;

export const globalInstructionsSaveInputSchema = z.object({
  common: z.string(),
  overrides: z.object({
    claude: z.string(),
    codex: z.string(),
  }),
});
export type GlobalInstructionsSaveInput = z.infer<
  typeof globalInstructionsSaveInputSchema
>;

export function composeInstructionFile(
  common: string,
  override: string,
): string {
  const parts = [common, override]
    .map((part) => part.replace(/\s+$/u, ""))
    .filter((part) => part.length > 0);
  if (parts.length === 0) return "";
  return `${parts.join("\n\n")}\n`;
}
