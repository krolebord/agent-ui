import { z } from "zod";

/** Slots stored in sqlite (common + per-harness overrides). */
export const globalInstructionSlotSchema = z.enum([
  "common",
  "claude",
  "codex",
]);
export type GlobalInstructionSlot = z.infer<typeof globalInstructionSlotSchema>;

/** Harnesses that receive a composed file on disk. */
export const globalInstructionHarnessSchema = z.enum(["claude", "codex"]);
export type GlobalInstructionHarness = z.infer<
  typeof globalInstructionHarnessSchema
>;

export const globalInstructionHarnessInfoSchema = z.object({
  target: globalInstructionHarnessSchema,
  /** Display path shown in the UI (tilde-prefixed when under home). */
  displayPath: z.string(),
  /** Absolute filesystem path written on save. */
  absolutePath: z.string(),
  /** Parent directory of absolutePath (for reveal-in-finder). */
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

/** Compose common + harness override into the file body written on disk. */
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
