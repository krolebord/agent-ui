import { describe, expect, it } from "vitest";
import { FakeEmbedder } from "../../../../src/main/session-memory/embedding/fake-embedder";

function dot(a: Float32Array, b: Float32Array): number {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

describe("FakeEmbedder", () => {
  it("returns deterministic unit vectors where shared words score higher", async () => {
    const embedder = new FakeEmbedder();
    const [sync, auth] = await embedder.embedDocuments([
      { title: "sync", text: "replicas merge offline edits" },
      { title: "auth", text: "session cookie expiration" },
    ]);
    const query = await embedder.embedQuery("how do offline edits merge");

    expect(sync).toHaveLength(768);
    expect(dot(sync, sync)).toBeCloseTo(1, 5);
    expect(dot(query, sync)).toBeGreaterThan(dot(query, auth));
    expect(await embedder.embedQuery("how do offline edits merge")).toEqual(
      query,
    );
    expect(await embedder.countTokens(["one two", ""])).toEqual([4, 2]);
    expect(embedder.calls.map((call) => call.type)).toEqual([
      "embedDocuments",
      "embedQuery",
      "embedQuery",
      "countTokens",
    ]);
  });

  it("rejects calls after dispose", async () => {
    const embedder = new FakeEmbedder();
    await embedder.dispose();
    await expect(embedder.embedQuery("q")).rejects.toThrow("disposed");
  });
});
