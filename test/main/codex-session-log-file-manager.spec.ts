import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexSessionLogFileManager } from "../../src/main/codex-session-log-file-manager";

describe("CodexSessionLogFileManager", () => {
  let tempDir: string;
  let manager: CodexSessionLogFileManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "codex-log-file-test-"));
    manager = new CodexSessionLogFileManager(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("create", () => {
    it("creates an empty JSONL file in claude-state subdirectory", () => {
      const filePath = manager.create("test-session-1");

      expect(filePath).toBe(
        path.join(tempDir, "claude-state", "codex-test-session-1.jsonl"),
      );
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf8")).toBe("");
    });

    it("creates the claude-state directory if it does not exist", () => {
      const logsDir = path.join(tempDir, "claude-state");
      expect(existsSync(logsDir)).toBe(false);

      manager.create("s1");

      expect(existsSync(logsDir)).toBe(true);
    });

    it("handles multiple creates without error", () => {
      manager.create("s1");
      manager.create("s2");

      expect(
        existsSync(path.join(tempDir, "claude-state", "codex-s1.jsonl")),
      ).toBe(true);
      expect(
        existsSync(path.join(tempDir, "claude-state", "codex-s2.jsonl")),
      ).toBe(true);
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
      manager.cleanup("/tmp/does-not-exist-12345.jsonl");
    });
  });
});
