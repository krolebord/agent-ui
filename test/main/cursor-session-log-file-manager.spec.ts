import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CursorSessionLogFileManager } from "../../src/main/cursor-session-log-file-manager";

describe("CursorSessionLogFileManager", () => {
  let tempDir: string;
  let manager: CursorSessionLogFileManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "cursor-log-file-test-"));
    manager = new CursorSessionLogFileManager(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("create", () => {
    it("creates an empty NDJSON file in claude-state subdirectory", () => {
      const filePath = manager.create("test-session-1");

      expect(filePath).toBe(
        path.join(tempDir, "claude-state", "cursor-test-session-1.ndjson"),
      );
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf8")).toBe("");
    });

    it("truncates an existing file when recreating it", () => {
      const filePath = manager.create("s1");
      writeFileSync(filePath, "stale-data\n", "utf8");

      const recreatedPath = manager.create("s1");

      expect(recreatedPath).toBe(filePath);
      expect(readFileSync(filePath, "utf8")).toBe("");
    });

    it("creates the claude-state directory if it does not exist", () => {
      const logsDir = path.join(tempDir, "claude-state");
      expect(existsSync(logsDir)).toBe(false);

      manager.create("s1");

      expect(existsSync(logsDir)).toBe(true);
    });
  });

  describe("cleanup", () => {
    it("removes the file", () => {
      const filePath = manager.create("s1");
      expect(existsSync(filePath)).toBe(true);

      manager.cleanup(filePath);

      expect(existsSync(filePath)).toBe(false);
    });

    it("does nothing for null path", () => {
      manager.cleanup(null);
    });

    it("does not throw for non-existent file", () => {
      manager.cleanup("/tmp/does-not-exist-12345.ndjson");
    });
  });
});
