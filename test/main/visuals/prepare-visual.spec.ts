import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inlineLocalImages,
  VisualImageTooLargeError,
  VisualPageTooLargeError,
} from "../../../src/main/visuals/prepare-visual";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
const PNG_DATA_URI = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;

describe("inlineLocalImages", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "prepare-visual-test-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("inlines absolute image paths in attributes, CSS urls, and JS strings", async () => {
    const imagePath = path.join(tempRoot, "shot.png");
    await writeFile(imagePath, PNG_BYTES);
    const html = [
      `<img src="${imagePath}">`,
      `<div style="background:url(${imagePath})"></div>`,
      `<script>const src = '${imagePath}';</script>`,
    ].join("");

    const result = await inlineLocalImages(html);

    expect(result.missingImages).toEqual([]);
    expect(result.html).toBe(
      [
        `<img src="${PNG_DATA_URI}">`,
        `<div style="background:url(${PNG_DATA_URI})"></div>`,
        `<script>const src = '${PNG_DATA_URI}';</script>`,
      ].join(""),
    );
  });

  it("inlines SVG files whose root element is svg", async () => {
    const svgPath = path.join(tempRoot, "icon.svg");
    await writeFile(
      svgPath,
      '<?xml version="1.0"?><!-- icon --><svg xmlns="http://www.w3.org/2000/svg"></svg>',
    );

    const result = await inlineLocalImages(`<img src="${svgPath}">`);

    expect(result.html).toContain('src="data:image/svg+xml;base64,');
    expect(result.missingImages).toEqual([]);
  });

  it("leaves non-image files named like images as written", async () => {
    const fakePath = path.join(tempRoot, "secret.png");
    await writeFile(fakePath, "API_KEY=hunter2");
    const html = `<img src="${fakePath}">`;

    const result = await inlineLocalImages(html);

    expect(result.html).toBe(html);
    expect(result.missingImages).toEqual([fakePath]);
  });

  it("reports missing images and ignores URLs and relative paths", async () => {
    const missingPath = path.join(tempRoot, "missing.png");
    const html = `<img src="${missingPath}"><img src="https://example.com/a.png"><img src="rel/b.png"><img src="//cdn.example.com/c.png">`;

    const result = await inlineLocalImages(html);

    expect(result.html).toBe(html);
    expect(result.missingImages).toEqual([missingPath]);
  });

  it("rejects an image over the per-image limit", async () => {
    const imagePath = path.join(tempRoot, "big.png");
    await writeFile(imagePath, Buffer.concat([PNG_BYTES, Buffer.alloc(100)]));

    await expect(
      inlineLocalImages(`<img src="${imagePath}">`, { maxImageBytes: 50 }),
    ).rejects.toBeInstanceOf(VisualImageTooLargeError);
  });

  it("rejects a page that would exceed the page limit once inlined", async () => {
    const imagePath = path.join(tempRoot, "shot.png");
    await writeFile(imagePath, Buffer.concat([PNG_BYTES, Buffer.alloc(200)]));

    await expect(
      inlineLocalImages(`<img src="${imagePath}">`, { maxPageBytes: 100 }),
    ).rejects.toBeInstanceOf(VisualPageTooLargeError);
  });
});
