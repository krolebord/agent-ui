import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPastedImagesDir,
  MAX_PASTED_IMAGE_BYTES,
  savePastedImage,
} from "../../src/main/pasted-images";

describe("savePastedImage", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "pasted-images-test-"));
    vi.spyOn(os, "tmpdir").mockReturnValue(tempRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("writes the decoded image to the pasted images dir", async () => {
    const bytes = Buffer.from("fake-png-bytes");
    const filePath = await savePastedImage({
      base64Data: bytes.toString("base64"),
      mimeType: "image/png",
    });

    expect(path.dirname(filePath)).toBe(getPastedImagesDir());
    expect(path.basename(filePath)).toMatch(/^pasted-image-.+\.png$/);
    expect(await readFile(filePath)).toEqual(bytes);
  });

  it("maps mime types to file extensions", async () => {
    const filePath = await savePastedImage({
      base64Data: Buffer.from("jpeg").toString("base64"),
      mimeType: "image/jpeg",
    });

    expect(filePath.endsWith(".jpg")).toBe(true);
  });

  it("rejects images that decode to zero bytes", async () => {
    await expect(
      savePastedImage({ base64Data: "!!!", mimeType: "image/png" }),
    ).rejects.toThrow("Pasted image is empty");
  });

  it("rejects images above the size limit", async () => {
    const oversized = Buffer.alloc(MAX_PASTED_IMAGE_BYTES + 1);
    await expect(
      savePastedImage({
        base64Data: oversized.toString("base64"),
        mimeType: "image/png",
      }),
    ).rejects.toThrow("too large");
  });

  it("cleans up expired pasted images", async () => {
    const dir = getPastedImagesDir();
    await savePastedImage({
      base64Data: Buffer.from("first").toString("base64"),
      mimeType: "image/png",
    });

    const stalePath = path.join(dir, "pasted-image-stale.png");
    await writeFile(stalePath, "stale");
    const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(stalePath, expired, expired);

    const freshPath = await savePastedImage({
      base64Data: Buffer.from("second").toString("base64"),
      mimeType: "image/png",
    });

    await vi.waitFor(async () => {
      const entries = await readdir(dir);
      expect(entries).not.toContain("pasted-image-stale.png");
    });
    expect(await readFile(freshPath, "utf8")).toBe("second");
  });
});
