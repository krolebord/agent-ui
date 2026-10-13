import { z } from "zod";
import { EMBEDDING_DIMENSIONS } from "./embedder";

export const embeddingWorkerConfigSchema = z.object({
  modelDir: z.string().min(1),
  maxTokens: z.number().int().min(3),
  threads: z.number().int().min(1),
});
export type EmbeddingWorkerConfig = z.infer<typeof embeddingWorkerConfigSchema>;

const requestId = z.number().int().nonnegative();

export const embeddingWorkerRequestSchema = z.discriminatedUnion("type", [
  z.object({
    id: requestId,
    type: z.literal("embedDocuments"),
    documents: z.array(
      z.object({ title: z.string().nullable(), text: z.string() }),
    ),
  }),
  z.object({
    id: requestId,
    type: z.literal("embedQueries"),
    queries: z.array(z.string()),
  }),
  z.object({
    id: requestId,
    type: z.literal("countTokens"),
    texts: z.array(z.string()),
  }),
]);
export type EmbeddingWorkerRequest = z.infer<
  typeof embeddingWorkerRequestSchema
>;

export const embeddingWorkerResponseSchema = z.discriminatedUnion("type", [
  z.object({
    id: requestId,
    type: z.literal("vectors"),
    vectors: z.array(
      z
        .instanceof(Float32Array)
        .refine((vector) => vector.length === EMBEDDING_DIMENSIONS, {
          message: `Expected ${EMBEDDING_DIMENSIONS} dimensions`,
        }),
    ),
  }),
  z.object({
    id: requestId,
    type: z.literal("tokenCounts"),
    counts: z.array(z.number().int().nonnegative()),
  }),
  z.object({
    id: requestId.nullable(),
    type: z.literal("error"),
    message: z.string(),
  }),
]);
export type EmbeddingWorkerResponse = z.infer<
  typeof embeddingWorkerResponseSchema
>;
