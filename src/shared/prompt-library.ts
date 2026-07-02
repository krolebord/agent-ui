import z from "zod";

export const promptLibraryEntrySchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1),
  body: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type PromptLibraryEntry = z.infer<typeof promptLibraryEntrySchema>;

export const promptLibrarySchema = z.array(promptLibraryEntrySchema).catch([]);
