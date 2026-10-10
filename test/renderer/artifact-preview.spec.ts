import {
  formatTextPreview,
  getArtifactPreviewKind,
  readTextPreview,
} from "@renderer/lib/artifact-preview";
import { describe, expect, it } from "vitest";

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  );
}

describe("getArtifactPreviewKind", () => {
  it.each([
    ["image/png", "image"],
    ["image/svg+xml", "image"],
    ["application/pdf", "pdf"],
    ["text/plain", "text"],
    ["text/html", "text"],
    ["text/markdown", "text"],
    ["application/json", "text"],
    ["application/zip", null],
    [undefined, null],
  ] as const)("maps %s to %s", (mimeType, kind) => {
    expect(getArtifactPreviewKind(mimeType)).toBe(kind);
  });
});

describe("readTextPreview", () => {
  it("reads the whole body when it fits", async () => {
    await expect(
      readTextPreview(streamResponse(["hello ", "world"]), 100),
    ).resolves.toEqual({ text: "hello world", truncated: false });
  });

  it("stops at the byte limit", async () => {
    await expect(
      readTextPreview(streamResponse(["abcd", "efgh", "ijkl"]), 6),
    ).resolves.toEqual({ text: "abcdef", truncated: true });
  });
});

describe("formatTextPreview", () => {
  it("pretty-prints JSON", () => {
    expect(formatTextPreview('{"a":1}', "application/json")).toBe(
      '{\n  "a": 1\n}',
    );
  });

  it("leaves invalid JSON and other text unchanged", () => {
    expect(formatTextPreview('{"a":', "application/json")).toBe('{"a":');
    expect(formatTextPreview('{"a":1}', "text/plain")).toBe('{"a":1}');
  });
});
