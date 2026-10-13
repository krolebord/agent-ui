import { describe, expect, it } from "vitest";
import {
  formatDocumentPrompt,
  formatQueryPrompt,
} from "../../../../src/main/session-memory/embedding/embedder";
import { loadEmbeddingRuntime } from "../../../../src/main/session-memory/embedding/runtime";

const modelDir = process.env.AGENT_UI_EMBEDDING_MODEL_DIR;

function dot(a: Float32Array, b: Float32Array): number {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

describe.skipIf(!modelDir)("embedding runtime with the real model", () => {
  it("embeds documents and queries into comparable unit vectors", async () => {
    const runtime = await loadEmbeddingRuntime({
      modelDir: modelDir as string,
      maxTokens: 1024,
      threads: 2,
    });
    try {
      const [sync, auth, query] = await runtime.embed([
        formatDocumentPrompt({
          title: "sync-deletes",
          text: "Deleting an item emits a tombstone. The synchronization process propagates the deletion so an older replica cannot resurrect the item.",
        }),
        formatDocumentPrompt({
          title: "auth-cookie",
          text: "Authentication uses a signed session cookie. The worker checks its expiration and renews it when the user logs in.",
        }),
        formatQueryPrompt(
          "What prevents removed records from reappearing after an old device synchronizes?",
        ),
      ]);
      expect(sync).toHaveLength(768);
      expect(dot(sync, sync)).toBeCloseTo(1, 5);
      expect(dot(query, sync)).toBeGreaterThan(dot(query, auth));
      expect(runtime.countTokens(["", "hello world"])).toEqual([2, 4]);
    } finally {
      await runtime.release();
    }
  }, 60_000);
});
