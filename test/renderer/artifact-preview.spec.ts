import {
  formatTextPreview,
  getArtifactPreviewKind,
  getHtmlPreviewSandbox,
  getNewArtifactToastTitle,
  getVisualFrameHeight,
  readTextPreview,
  shouldToastNewArtifact,
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
    ["text/html", "html"],
    ["text/markdown", "text"],
    ["application/json", "text"],
    ["application/zip", null],
    [undefined, null],
  ] as const)("maps %s to %s", (mimeType, kind) => {
    expect(getArtifactPreviewKind(mimeType)).toBe(kind);
  });
});

describe("getHtmlPreviewSandbox", () => {
  it("lets visuals run scripts and open links without same-origin access", () => {
    const sandbox = getHtmlPreviewSandbox("visual");
    expect(sandbox.split(" ")).toEqual([
      "allow-scripts",
      "allow-popups",
      "allow-popups-to-escape-sandbox",
    ]);
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("fully sandboxes plain HTML files", () => {
    expect(getHtmlPreviewSandbox("file")).toBe("");
  });
});

describe("new artifact toasts", () => {
  it("skips file artifacts from the session in view", () => {
    expect(
      shouldToastNewArtifact({ kind: "file", sessionId: "s1" }, "s1"),
    ).toBe(false);
    expect(
      shouldToastNewArtifact({ kind: "file", sessionId: "s1" }, "s2"),
    ).toBe(true);
    expect(
      shouldToastNewArtifact({ kind: "file", sessionId: "s1" }, null),
    ).toBe(true);
  });

  it("always announces visuals", () => {
    expect(
      shouldToastNewArtifact({ kind: "visual", sessionId: "s1" }, "s1"),
    ).toBe(true);
  });

  it("titles visuals and files differently", () => {
    expect(getNewArtifactToastTitle({ kind: "visual", name: "Chart" })).toBe(
      "Visual ready: Chart",
    );
    expect(getNewArtifactToastTitle({ kind: "file", name: "a.zip" })).toBe(
      "Artifact created: a.zip",
    );
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

describe("getVisualFrameHeight", () => {
  it("keeps the default height until the page reports one", () => {
    expect(getVisualFrameHeight(undefined)).toBeUndefined();
  });

  it("fits the reported height, capped by the viewport", () => {
    expect(getVisualFrameHeight(248.4)).toBe("min(249px, 70vh)");
  });

  it("never shrinks below the minimum height", () => {
    expect(getVisualFrameHeight(20)).toBe("min(120px, 70vh)");
  });
});
