import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getProjectFaviconDataUrl,
  resetProjectFaviconCache,
} from "../../src/main/project-favicon";

vi.mock("../../src/main/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe("project-favicon", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = path.join(
      tmpdir(),
      `project-favicon-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(projectDir, { recursive: true });
    resetProjectFaviconCache();
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  async function writeProjectFile(
    relativePath: string,
    content: string,
  ): Promise<void> {
    const absolutePath = path.join(projectDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf-8");
  }

  async function writeSettings(settings: string): Promise<void> {
    await writeProjectFile(".agent-ui/settings.jsonc", settings);
  }

  function decode(dataUrl: string): { mimeType: string; content: string } {
    const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (!match) {
      throw new Error(`Not a base64 data URL: ${dataUrl.slice(0, 40)}`);
    }
    return {
      mimeType: match[1],
      content: Buffer.from(match[2], "base64").toString("utf-8"),
    };
  }

  it("returns null when the project has no icon", async () => {
    await expect(getProjectFaviconDataUrl(projectDir)).resolves.toBeNull();
  });

  it("returns null for a path that does not exist", async () => {
    await expect(
      getProjectFaviconDataUrl(path.join(projectDir, "missing")),
    ).resolves.toBeNull();
  });

  it("finds a root favicon and inlines it as a data URL", async () => {
    await writeProjectFile("favicon.svg", "<svg>root</svg>");

    const dataUrl = await getProjectFaviconDataUrl(projectDir);

    expect(dataUrl).not.toBeNull();
    expect(decode(dataUrl as string)).toEqual({
      mimeType: "image/svg+xml",
      content: "<svg>root</svg>",
    });
  });

  it("finds icons in framework locations", async () => {
    await writeProjectFile("src/app/favicon.ico", "ico-bytes");

    const dataUrl = await getProjectFaviconDataUrl(projectDir);

    expect(decode(dataUrl as string)).toEqual({
      mimeType: "image/x-icon",
      content: "ico-bytes",
    });
  });

  it("prefers vector over ico over raster at the same level", async () => {
    await writeProjectFile("public/favicon.png", "png");
    await writeProjectFile("public/favicon.ico", "ico");
    await writeProjectFile("public/favicon.svg", "<svg />");

    const dataUrl = await getProjectFaviconDataUrl(projectDir);

    expect(decode(dataUrl as string).mimeType).toBe("image/svg+xml");
  });

  it("prefers the project's own .agent-ui/icon.svg over conventional paths", async () => {
    await writeProjectFile("favicon.svg", "<svg>conventional</svg>");
    await writeProjectFile(".agent-ui/icon.svg", "<svg>ours</svg>");

    const dataUrl = await getProjectFaviconDataUrl(projectDir);

    expect(decode(dataUrl as string).content).toBe("<svg>ours</svg>");
  });

  it("prefers a configured iconPath over every conventional path", async () => {
    await writeProjectFile("favicon.svg", "<svg>conventional</svg>");
    await writeProjectFile(".agent-ui/icon.svg", "<svg>ours</svg>");
    await writeProjectFile("brand/logo.png", "configured");
    await writeSettings(`{
  // Icon for this project
  "iconPath": "brand/logo.png"
}`);

    const dataUrl = await getProjectFaviconDataUrl(projectDir);

    expect(decode(dataUrl as string)).toEqual({
      mimeType: "image/png",
      content: "configured",
    });
  });

  it("falls back to conventional paths when iconPath points nowhere", async () => {
    await writeProjectFile("favicon.svg", "<svg>conventional</svg>");
    await writeSettings(`{ "iconPath": "brand/missing.png" }`);

    const dataUrl = await getProjectFaviconDataUrl(projectDir);

    expect(decode(dataUrl as string).content).toBe("<svg>conventional</svg>");
  });

  it("refuses an iconPath that escapes the project root", async () => {
    const outsideDir = path.join(projectDir, "..", `outside-${Date.now()}`);
    await mkdir(outsideDir, { recursive: true });
    await writeFile(path.join(outsideDir, "secret.svg"), "<svg>secret</svg>");
    await writeSettings(
      `{ "iconPath": "../${path.basename(outsideDir)}/secret.svg" }`,
    );

    try {
      await expect(getProjectFaviconDataUrl(projectDir)).resolves.toBeNull();
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("refuses an absolute iconPath", async () => {
    await writeProjectFile("secret.svg", "<svg>secret</svg>");
    await writeSettings(
      `{ "iconPath": ${JSON.stringify(path.join(projectDir, "secret.svg"))} }`,
    );

    await expect(getProjectFaviconDataUrl(projectDir)).resolves.toBeNull();
  });

  it("refuses an iconPath whose extension is not an image", async () => {
    await writeProjectFile("id_rsa", "PRIVATE KEY");
    await writeSettings(`{ "iconPath": "id_rsa" }`);

    await expect(getProjectFaviconDataUrl(projectDir)).resolves.toBeNull();
  });

  it("skips empty and oversized files", async () => {
    await writeProjectFile("favicon.svg", "");
    await writeProjectFile("favicon.ico", "x".repeat(512 * 1024 + 1));
    await writeProjectFile("favicon.png", "png");

    const dataUrl = await getProjectFaviconDataUrl(projectDir);

    expect(decode(dataUrl as string).content).toBe("png");
  });

  it("ignores a directory sitting at a candidate path", async () => {
    await mkdir(path.join(projectDir, "favicon.svg"), { recursive: true });
    await writeProjectFile("favicon.png", "png");

    const dataUrl = await getProjectFaviconDataUrl(projectDir);

    expect(decode(dataUrl as string).content).toBe("png");
  });

  it("picks up an edited icon on the next request", async () => {
    await writeProjectFile("favicon.svg", "<svg>before</svg>");
    expect(
      decode((await getProjectFaviconDataUrl(projectDir)) as string).content,
    ).toBe("<svg>before</svg>");

    await writeProjectFile("favicon.svg", "<svg>after the edit</svg>");

    expect(
      decode((await getProjectFaviconDataUrl(projectDir)) as string).content,
    ).toBe("<svg>after the edit</svg>");
  });

  it("serves a cached icon without rescanning candidates", async () => {
    await writeProjectFile("assets/logo.png", "logo");
    const first = await getProjectFaviconDataUrl(projectDir);

    // A higher-priority icon appearing is invisible until the cached file
    // changes: the tradeoff that keeps repeat reads to a single stat.
    await writeProjectFile("favicon.svg", "<svg>new</svg>");

    await expect(getProjectFaviconDataUrl(projectDir)).resolves.toBe(first);
  });

  it("rescans after the cached icon disappears", async () => {
    await writeProjectFile("favicon.svg", "<svg>gone soon</svg>");
    await getProjectFaviconDataUrl(projectDir);

    await rm(path.join(projectDir, "favicon.svg"));
    await writeProjectFile("favicon.png", "png");

    expect(
      decode((await getProjectFaviconDataUrl(projectDir)) as string).content,
    ).toBe("png");
  });

  it("does not rescan immediately after finding no icon", async () => {
    await expect(getProjectFaviconDataUrl(projectDir)).resolves.toBeNull();

    await writeProjectFile("favicon.svg", "<svg>late</svg>");

    await expect(getProjectFaviconDataUrl(projectDir)).resolves.toBeNull();
  });
});
