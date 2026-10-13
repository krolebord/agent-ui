import { describe, expect, it } from "vitest";
import {
  embeddingWorkerConfigSchema,
  embeddingWorkerRequestSchema,
  embeddingWorkerResponseSchema,
} from "../../../../src/main/session-memory/embedding/ipc";

describe("embedding worker IPC schemas", () => {
  it("accepts each request type", () => {
    for (const request of [
      {
        id: 0,
        type: "embedDocuments",
        documents: [{ title: null, text: "a" }],
      },
      { id: 1, type: "embedQueries", queries: ["q"] },
      { id: 2, type: "countTokens", texts: ["t"] },
    ]) {
      expect(embeddingWorkerRequestSchema.parse(request)).toEqual(request);
    }
  });

  it("rejects malformed requests", () => {
    for (const request of [
      null,
      "embed",
      { id: 0, type: "embed", texts: [] },
      { id: -1, type: "countTokens", texts: [] },
      { id: 0, type: "embedDocuments", documents: [{ text: "missing title" }] },
      { id: 0, type: "embedQueries", queries: [1] },
    ]) {
      expect(embeddingWorkerRequestSchema.safeParse(request).success).toBe(
        false,
      );
    }
  });

  it("requires 768-dimensional Float32Array vectors", () => {
    const valid = {
      id: 3,
      type: "vectors",
      vectors: [new Float32Array(768)],
    };
    expect(embeddingWorkerResponseSchema.parse(valid)).toEqual(valid);
    expect(
      embeddingWorkerResponseSchema.safeParse({
        ...valid,
        vectors: [new Float32Array(767)],
      }).success,
    ).toBe(false);
    expect(
      embeddingWorkerResponseSchema.safeParse({
        ...valid,
        vectors: [Array.from({ length: 768 }, () => 0)],
      }).success,
    ).toBe(false);
  });

  it("accepts errors without a request id", () => {
    expect(
      embeddingWorkerResponseSchema.parse({
        id: null,
        type: "error",
        message: "bad request",
      }),
    ).toEqual({ id: null, type: "error", message: "bad request" });
  });

  it("validates worker config", () => {
    expect(
      embeddingWorkerConfigSchema.safeParse({
        modelDir: "/models",
        maxTokens: 1024,
        threads: 2,
      }).success,
    ).toBe(true);
    expect(
      embeddingWorkerConfigSchema.safeParse({
        modelDir: "",
        maxTokens: 1024,
        threads: 2,
      }).success,
    ).toBe(false);
    expect(
      embeddingWorkerConfigSchema.safeParse({
        modelDir: "/models",
        maxTokens: 2,
        threads: 2,
      }).success,
    ).toBe(false);
  });
});
