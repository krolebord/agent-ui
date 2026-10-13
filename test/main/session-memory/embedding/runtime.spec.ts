import { describe, expect, it } from "vitest";
import {
  formatDocumentPrompt,
  formatQueryPrompt,
} from "../../../../src/main/session-memory/embedding/embedder";
import {
  l2Normalize,
  meanPool,
  type TextTokenizer,
  toModelInputIds,
} from "../../../../src/main/session-memory/embedding/runtime";

const tokenizer: TextTokenizer = {
  bosId: 2,
  eosId: 1,
  encode: (text) => text.split(" ").map((word) => word.length + 10),
};

describe("embedding prompts", () => {
  it("formats documents and queries like EmbeddingGemma expects", () => {
    expect(formatDocumentPrompt({ title: "Sync", text: "body" })).toBe(
      "title: Sync | text: body",
    );
    expect(formatDocumentPrompt({ title: null, text: "body" })).toBe(
      "title: none | text: body",
    );
    expect(formatDocumentPrompt({ title: "", text: "body" })).toBe(
      "title: none | text: body",
    );
    expect(formatQueryPrompt("what broke?")).toBe(
      "task: search result | query: what broke?",
    );
  });
});

describe("toModelInputIds", () => {
  it("wraps tokens in BOS and EOS", () => {
    expect(toModelInputIds(tokenizer, "a bb", 1024)).toEqual([2, 11, 12, 1]);
  });

  it("truncates content so the total including BOS and EOS fits", () => {
    expect(toModelInputIds(tokenizer, "a bb ccc dddd", 4)).toEqual([
      2, 11, 12, 1,
    ]);
  });
});

describe("meanPool", () => {
  it("averages token vectors", () => {
    const hidden = new Float32Array([1, 2, 3, 4, 5, 6]);
    expect(Array.from(meanPool(hidden, 2, 3))).toEqual([2.5, 3.5, 4.5]);
  });
});

describe("l2Normalize", () => {
  it("scales to unit length", () => {
    expect(Array.from(l2Normalize(new Float32Array([3, 4])))).toEqual([
      0.6000000238418579, 0.800000011920929,
    ]);
  });

  it("rejects zero vectors", () => {
    expect(() => l2Normalize(new Float32Array(3))).toThrow("zero");
  });
});
