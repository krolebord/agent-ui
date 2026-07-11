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
import { getPastedFilesDir, savePastedFile } from "../../src/main/pasted-files";
import { MAX_PASTED_FILE_BYTES } from "../../src/shared/pasted-files";

describe("savePastedFile", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "pasted-files-test-"));
    vi.spyOn(os, "tmpdir").mockReturnValue(tempRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("preserves the original file name inside a unique subdirectory", async () => {
    const bytes = Buffer.from("hello world");
    const { filePath } = await savePastedFile({
      base64Data: bytes.toString("base64"),
      fileName: "report.pdf",
      mimeType: "application/pdf",
    });

    expect(path.basename(filePath)).toBe("report.pdf");
    // <pasted-files-dir>/<uuid>/report.pdf
    expect(path.dirname(path.dirname(filePath))).toBe(getPastedFilesDir());
    expect(await readFile(filePath)).toEqual(bytes);
  });

  it("collapses whitespace in file names so the path is a single token", async () => {
    const { filePath } = await savePastedFile({
      base64Data: Buffer.from("x").toString("base64"),
      fileName: "My Big Report.pdf",
    });

    expect(path.basename(filePath)).toBe("My_Big_Report.pdf");
  });

  it("strips directory components to prevent path traversal", async () => {
    const { filePath } = await savePastedFile({
      base64Data: Buffer.from("x").toString("base64"),
      fileName: "../../etc/passwd",
    });

    expect(path.basename(filePath)).toBe("passwd");
    expect(path.dirname(path.dirname(filePath))).toBe(getPastedFilesDir());
  });

  it("synthesizes an image name when the clipboard file is unnamed", async () => {
    const { filePath } = await savePastedFile({
      base64Data: Buffer.from("png").toString("base64"),
      mimeType: "image/png",
    });

    expect(path.basename(filePath)).toBe("pasted-file.png");
  });

  it("falls back to a .bin name for unnamed non-image files", async () => {
    const { filePath } = await savePastedFile({
      base64Data: Buffer.from("data").toString("base64"),
    });

    expect(path.basename(filePath)).toBe("pasted-file.bin");
  });

  it("rejects files that decode to zero bytes", async () => {
    await expect(
      savePastedFile({ base64Data: "!!!", fileName: "a.txt" }),
    ).rejects.toThrow("Pasted file is empty");
  });

  it("rejects files above the size limit", async () => {
    const oversized = Buffer.alloc(MAX_PASTED_FILE_BYTES + 1);
    await expect(
      savePastedFile({
        base64Data: oversized.toString("base64"),
        fileName: "big.bin",
      }),
    ).rejects.toThrow("too large");
  });

  it("cleans up expired pasted files", async () => {
    const root = getPastedFilesDir();
    // Seed the directory so it exists, then plant a stale entry in it.
    await savePastedFile({
      base64Data: Buffer.from("first").toString("base64"),
      fileName: "first.txt",
    });

    const stalePath = path.join(root, "stale-marker");
    await writeFile(stalePath, "stale");
    const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(stalePath, expired, expired);

    const { filePath: freshPath } = await savePastedFile({
      base64Data: Buffer.from("second").toString("base64"),
      fileName: "second.txt",
    });

    await vi.waitFor(async () => {
      const entries = await readdir(root);
      expect(entries).not.toContain("stale-marker");
    });
    expect(await readFile(freshPath, "utf8")).toBe("second");
  });
});
