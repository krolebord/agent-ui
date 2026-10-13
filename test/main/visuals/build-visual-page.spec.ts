import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const inlineMocks = vi.hoisted(() => ({ inputs: [] as string[] }));

vi.mock("../../../src/main/visuals/prepare-visual", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/main/visuals/prepare-visual")
    >();
  return {
    ...actual,
    inlineLocalImages: async (
      html: string,
      limits?: Parameters<typeof actual.inlineLocalImages>[1],
    ) => {
      inlineMocks.inputs.push(html);
      return await actual.inlineLocalImages(html, limits);
    },
  };
});

import { buildVisualPage } from "../../../src/main/visuals/build-visual-page";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);

describe("buildVisualPage", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "visual-page-test-"));
    inlineMocks.inputs = [];
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("adds a doctype when the page has none", async () => {
    const page = await buildVisualPage("<p>Hello</p>");

    expect(page.html.startsWith("<!doctype html>")).toBe(true);
    expect(page.html).toContain('<style id="agent-ui-theme">');
    expect(page.html.endsWith("<p>Hello</p>")).toBe(true);
  });

  it("keeps an existing doctype", async () => {
    const page = await buildVisualPage(
      "<!DOCTYPE html><html><head></head><body>x</body></html>",
    );

    expect(page.html.match(/<!doctype/gi)).toHaveLength(1);
    expect(page.html.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("injects the bootstrap before inlining local images", async () => {
    const imagePath = path.join(tempRoot, "shot.png");
    await writeFile(imagePath, PNG_BYTES);

    const page = await buildVisualPage(`<img src="${imagePath}">`);

    expect(inlineMocks.inputs).toHaveLength(1);
    expect(inlineMocks.inputs[0]).toContain('<style id="agent-ui-theme">');
    expect(inlineMocks.inputs[0]).toContain(imagePath);
    expect(page.html).toContain(
      `data:image/png;base64,${PNG_BYTES.toString("base64")}`,
    );
    expect(page.missingImages).toEqual([]);
  });

  it("reports images it cannot read", async () => {
    const missing = path.join(tempRoot, "missing.png");

    const page = await buildVisualPage(`<img src="${missing}">`);

    expect(page.missingImages).toEqual([missing]);
  });
});
