import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStateFileManager } from "../../src/main/session-state-file-manager";

describe("SessionStateFileManager", () => {
  let tempDir: string;
  let manager: SessionStateFileManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "state-file-test-"));
    manager = new SessionStateFileManager(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("create", () => {
    it("creates an empty NDJSON file in claude-state subdirectory", async () => {
      const filePath = await manager.create("test-session-1");

      expect(filePath).toBe(
        path.join(tempDir, "claude-state", "s-test-session-1.ndjson"),
      );
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf8")).toBe("");
    });

    it("creates the claude-state directory if it does not exist", async () => {
      const stateDir = path.join(tempDir, "claude-state");
      expect(existsSync(stateDir)).toBe(false);

      await manager.create("s1");

      expect(existsSync(stateDir)).toBe(true);
    });

    it("handles multiple creates without error", async () => {
      await manager.create("s1");
      await manager.create("s2");

      expect(
        existsSync(path.join(tempDir, "claude-state", "s-s1.ndjson")),
      ).toBe(true);
      expect(
        existsSync(path.join(tempDir, "claude-state", "s-s2.ndjson")),
      ).toBe(true);
    });
  });

  describe("cleanup", () => {
    it("removes the file", async () => {
      const filePath = await manager.create("s1");
      expect(existsSync(filePath)).toBe(true);

      manager.cleanup(filePath);

      expect(existsSync(filePath)).toBe(false);
    });

    it("does nothing for null path", () => {
      // Should not throw
      manager.cleanup(null);
    });

    it("does not throw for non-existent file", () => {
      manager.cleanup("/tmp/does-not-exist-12345.ndjson");
    });
  });
});
