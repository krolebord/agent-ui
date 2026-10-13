import { describe, expect, it, vi } from "vitest";
import {
  type ChunkerOptions,
  embedHash,
  planTurnChunks,
  renderTurnText,
  userTextPrefix,
} from "../../../src/main/session-memory/chunking";
import { formatDocumentPrompt } from "../../../src/main/session-memory/embedding/embedder";

const charsPerToken = 4;
const countTokens = vi.fn(async (texts: string[]) =>
  texts.map((text) => Math.ceil(text.length / charsPerToken) + 2),
);

const options: ChunkerOptions = {
  maxTokens: 120,
  maxHeadChunks: 3,
  userPrefixChars: 40,
  reserveTokens: 8,
  maxSplitDepth: 4,
};

function paragraph(label: string, words: number): string {
  return Array.from({ length: words }, (_, index) => `${label}${index}`).join(
    " ",
  );
}

async function promptTokens(title: string | null, text: string) {
  const [count] = await countTokens([formatDocumentPrompt({ title, text })]);
  return count;
}

describe("planTurnChunks", () => {
  it("keeps a turn that fits as a single chunk", async () => {
    countTokens.mockClear();
    const chunks = await planTurnChunks(
      { title: "Fix login", userText: "why?", assistantText: "because." },
      countTokens,
      options,
    );

    expect(chunks).toEqual([
      {
        index: 0,
        text: "User: why?\n\nAssistant: because.",
        tokenCount: await promptTokens(
          "Fix login",
          "User: why?\n\nAssistant: because.",
        ),
        embedHash: embedHash("Fix login", "User: why?\n\nAssistant: because."),
      },
    ]);
    expect(countTokens).toHaveBeenCalledTimes(2);
  });

  it("omits an empty side and returns nothing for an empty turn", async () => {
    expect(renderTurnText("", "only answer")).toBe("Assistant: only answer");
    expect(
      await planTurnChunks(
        { title: null, userText: " ", assistantText: "" },
        countTokens,
        options,
      ),
    ).toEqual([]);
  });

  it("splits long turns on paragraph boundaries within the token limit", async () => {
    const userText = "Please refactor the session sync so it batches writes";
    const assistantText = [
      paragraph("alpha", 40),
      paragraph("beta", 40),
      paragraph("gamma", 40),
      paragraph("delta", 40),
    ].join("\n\n");

    const chunks = await planTurnChunks(
      { title: "Refactor", userText, assistantText },
      countTokens,
      { ...options, maxHeadChunks: 10 },
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(options.maxTokens);
      expect(chunk.tokenCount).toBe(await promptTokens("Refactor", chunk.text));
    }
    expect(chunks.map((chunk) => chunk.index)).toEqual(
      chunks.map((_, index) => index),
    );
    expect(chunks[0].text).toMatch(
      new RegExp(`^User: ${userText}\n\nAssistant: alpha0 alpha1`),
    );
    for (const chunk of chunks.slice(1)) {
      expect(chunk.text).toMatch(
        /^User: Please refactor the session sync so it…\n\nAssistant \(continued\): /,
      );
    }
    const words = chunks
      .map((chunk) => chunk.text)
      .join(" ")
      .match(/\b(alpha|beta|gamma|delta)\d+\b/g);
    expect(new Set(words).size).toBe(160);
  });

  it("splits a turn slightly over the limit into two balanced chunks", async () => {
    const assistantText = Array.from({ length: 12 }, (_, index) =>
      paragraph(`s${index}w`, 8),
    ).join("\n\n");

    const chunks = await planTurnChunks(
      { title: null, userText: "q", assistantText },
      countTokens,
      options,
    );

    expect(chunks).toHaveLength(2);
    const [first, second] = chunks.map((chunk) => chunk.tokenCount);
    expect(Math.abs(first - second)).toBeLessThan(30);
  });

  it("splits a single huge line by characters", async () => {
    const chunks = await planTurnChunks(
      { title: null, userText: "x", assistantText: "y".repeat(2_000) },
      countTokens,
      options,
    );
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(options.maxTokens);
    }
  });

  it("keeps the head chunks and the last chunk of a giant turn", async () => {
    const paragraphs = Array.from({ length: 40 }, (_, index) =>
      paragraph(`p${index}w`, 30),
    );
    const chunks = await planTurnChunks(
      {
        title: null,
        userText: "summarize",
        assistantText: paragraphs.join("\n\n"),
      },
      countTokens,
      options,
    );

    expect(chunks).toHaveLength(options.maxHeadChunks + 1);
    expect(chunks.at(-1)?.text).toContain("p39w29");
    expect(chunks.map((chunk) => chunk.text).join("")).not.toContain("p20w0 ");
  });

  it("re-splits chunks the estimate got wrong", async () => {
    const skewed = vi.fn(async (texts: string[]) =>
      texts.map(
        (text) =>
          Math.ceil(
            [...text].reduce((sum, char) => sum + (char === "#" ? 1 : 0.2), 0),
          ) + 2,
      ),
    );
    const assistantText = [
      "plain ".repeat(150),
      "#".repeat(100),
      "# # ".repeat(40),
    ].join("\n\n");

    const chunks = await planTurnChunks(
      { title: null, userText: "go", assistantText },
      skewed,
      options,
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(options.maxTokens);
    }
  });

  it("produces stable hashes that change with the title", async () => {
    const input = {
      title: "A",
      userText: "question",
      assistantText: paragraph("word", 120),
    };
    const first = await planTurnChunks(input, countTokens, options);
    const second = await planTurnChunks(input, countTokens, options);
    const retitled = await planTurnChunks(
      { ...input, title: "B" },
      countTokens,
      options,
    );

    expect(second).toEqual(first);
    expect(retitled.map((chunk) => chunk.text)).toEqual(
      first.map((chunk) => chunk.text),
    );
    for (const [index, chunk] of retitled.entries()) {
      expect(chunk.embedHash).not.toBe(first[index].embedHash);
    }
  });
});

describe("userTextPrefix", () => {
  it("collapses whitespace and cuts on a word boundary", () => {
    expect(userTextPrefix("short\n\ntext", 40)).toBe("short text");
    expect(userTextPrefix("one two three four five six", 15)).toBe(
      "one two three…",
    );
  });
});
