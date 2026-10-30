import {
  canEditArtifact,
  formatTextPreview,
  getArtifactNavigation,
  getArtifactPreviewKind,
  getHtmlPreviewSandbox,
  getNewArtifactToastTitle,
  getTextPreviewFile,
  getVisualFrameHeight,
  hasArtifactSourceView,
  readTextPreview,
  shouldToastNewArtifact,
} from "@renderer/lib/artifact-preview";
import { MAX_EDITABLE_ARTIFACT_BYTES } from "@shared/artifacts";
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

describe("hasArtifactSourceView", () => {
  it.each([
    ["file", "image/svg+xml", true],
    ["file", "text/html", true],
    ["visual", "text/html", false],
    ["file", "image/png", false],
    ["file", "text/plain", false],
  ] as const)("%s %s -> %s", (kind, mimeType, expected) => {
    expect(hasArtifactSourceView({ kind, mimeType })).toBe(expected);
  });
});

describe("canEditArtifact", () => {
  const file = { kind: "file", available: true, size: 10 } as const;

  it("edits available text files within the size limit", () => {
    expect(canEditArtifact(file, "text")).toBe(true);
  });

  it.each([
    ["visuals", { ...file, kind: "visual" }, "text"],
    ["missing files", { ...file, available: false }, "text"],
    ["large files", { ...file, size: MAX_EDITABLE_ARTIFACT_BYTES + 1 }, "text"],
    ["images", file, "image"],
    ["HTML", file, "html"],
  ] as const)("does not edit %s", (_label, artifact, kind) => {
    expect(canEditArtifact(artifact, kind)).toBe(false);
  });
});

describe("getTextPreviewFile", () => {
  it("uses the file name on disk so a custom title keeps its language", () => {
    expect(
      getTextPreviewFile({ name: "Plan", path: "/repo/src/plan.ts" }, "x").name,
    ).toBe("plan.ts");
    expect(
      getTextPreviewFile({ name: "Plan", path: "C:\\repo\\plan.py" }, "x").name,
    ).toBe("plan.py");
  });

  it("highlights SVG source as XML", () => {
    expect(
      getTextPreviewFile(
        { name: "logo", path: "/a/logo.svg", mimeType: "image/svg+xml" },
        "<svg/>",
      ).lang,
    ).toBe("xml");
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
  it("skips artifacts and visuals from the session in view", () => {
    expect(shouldToastNewArtifact({ sessionId: "s1" }, "s1")).toBe(false);
    expect(shouldToastNewArtifact({ sessionId: "s1" }, "s2")).toBe(true);
    expect(shouldToastNewArtifact({ sessionId: "s1" }, null)).toBe(true);
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

describe("getArtifactNavigation", () => {
  it("returns neighbours of the current artifact", () => {
    expect(getArtifactNavigation(["a", "b", "c"], "b")).toEqual({
      index: 1,
      previousId: "a",
      nextId: "c",
    });
  });

  it("stops at both ends instead of wrapping", () => {
    expect(getArtifactNavigation(["a", "b"], "a")).toEqual({
      index: 0,
      previousId: null,
      nextId: "b",
    });
    expect(getArtifactNavigation(["a", "b"], "b")).toEqual({
      index: 1,
      previousId: "a",
      nextId: null,
    });
  });

  it("has no neighbours when the current artifact is not listed", () => {
    expect(getArtifactNavigation(["a", "b"], "x")).toEqual({
      index: -1,
      previousId: null,
      nextId: null,
    });
  });
});
