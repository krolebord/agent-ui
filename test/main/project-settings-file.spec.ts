import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readProjectSettingsFile,
  readProjectSettingsForAll,
  writeProjectSettingsFile,
} from "../../src/main/project-settings-file";

describe("project-settings-file", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdir(path.join(tmpdir(), `project-settings-test-${Date.now()}`), {
      recursive: true,
    }).then(() => path.join(tmpdir(), `project-settings-test-${Date.now()}`));
    // Use a fresh unique dir
    tempDir = path.join(tmpdir(), `project-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const settingsPath = () => path.join(tempDir, ".claude-ui", "settings.jsonc");

  describe("readProjectSettingsFile", () => {
    it("returns null for missing file", async () => {
      const result = await readProjectSettingsFile(tempDir);
      expect(result).toBeNull();
    });

    it("parses valid JSONC with comments", async () => {
      await mkdir(path.join(tempDir, ".claude-ui"), { recursive: true });
      await writeFile(
        settingsPath(),
        `{
  // Default model for this project
  "defaultModel": "sonnet",
  "defaultEffort": "high"
}`,
        "utf-8",
      );

      const result = await readProjectSettingsFile(tempDir);
      expect(result).toEqual({
        defaultModel: "sonnet",
        defaultEffort: "high",
      });
    });

    it("handles invalid JSON gracefully", async () => {
      await mkdir(path.join(tempDir, ".claude-ui"), { recursive: true });
      await writeFile(settingsPath(), "not json at all {{{", "utf-8");

      const result = await readProjectSettingsFile(tempDir);
      expect(result).toBeNull();
    });

    it("uses .catch(undefined) for unknown enum values", async () => {
      await mkdir(path.join(tempDir, ".claude-ui"), { recursive: true });
      await writeFile(
        settingsPath(),
        `{
  "defaultModel": "unknown-model-xyz",
  "defaultEffort": "high"
}`,
        "utf-8",
      );

      const result = await readProjectSettingsFile(tempDir);
      expect(result).toEqual({
        defaultModel: undefined,
        defaultEffort: "high",
      });
    });

    it("strips unknown keys", async () => {
      await mkdir(path.join(tempDir, ".claude-ui"), { recursive: true });
      await writeFile(
        settingsPath(),
        `{ "defaultModel": "opus", "unknownKey": true }`,
        "utf-8",
      );

      const result = await readProjectSettingsFile(tempDir);
      expect(result).toEqual({ defaultModel: "opus" });
      expect(result).not.toHaveProperty("unknownKey");
    });
  });

  describe("writeProjectSettingsFile", () => {
    it("creates .claude-ui directory and file", async () => {
      await writeProjectSettingsFile(tempDir, {
        defaultModel: "sonnet",
        defaultEffort: "high",
      });

      expect(existsSync(settingsPath())).toBe(true);
      const content = readFileSync(settingsPath(), "utf-8");
      expect(content).toContain('"defaultModel": "sonnet"');
      expect(content).toContain('"defaultEffort": "high"');
    });

    it("preserves existing comments on re-write", async () => {
      await mkdir(path.join(tempDir, ".claude-ui"), { recursive: true });
      const original = `{
  // This is a project comment
  "defaultModel": "sonnet",
  "defaultEffort": "low"
}`;
      await writeFile(settingsPath(), original, "utf-8");

      await writeProjectSettingsFile(tempDir, {
        defaultModel: "opus",
        defaultEffort: "high",
      });

      const content = readFileSync(settingsPath(), "utf-8");
      expect(content).toContain("// This is a project comment");
      expect(content).toContain('"defaultModel": "opus"');
      expect(content).toContain('"defaultEffort": "high"');
    });

    it("removes keys set to undefined", async () => {
      await writeProjectSettingsFile(tempDir, {
        defaultModel: "sonnet",
        defaultEffort: "high",
      });

      await writeProjectSettingsFile(tempDir, {
        defaultModel: undefined,
        defaultEffort: "high",
      });

      const content = readFileSync(settingsPath(), "utf-8");
      expect(content).not.toContain("defaultModel");
      expect(content).toContain('"defaultEffort": "high"');
    });
  });

  describe("readProjectSettingsForAll", () => {
    it("returns settings for projects that have files", async () => {
      const projectA = path.join(tempDir, "project-a");
      const projectB = path.join(tempDir, "project-b");
      const projectC = path.join(tempDir, "project-c");

      await mkdir(path.join(projectA, ".claude-ui"), { recursive: true });
      await writeFile(
        path.join(projectA, ".claude-ui", "settings.jsonc"),
        '{ "defaultModel": "opus" }',
        "utf-8",
      );

      await mkdir(projectB, { recursive: true });
      // project-b has no settings file

      await mkdir(path.join(projectC, ".claude-ui"), { recursive: true });
      await writeFile(
        path.join(projectC, ".claude-ui", "settings.jsonc"),
        '{ "defaultEffort": "low" }',
        "utf-8",
      );

      const map = await readProjectSettingsForAll([projectA, projectB, projectC]);

      expect(map.size).toBe(2);
      expect(map.get(projectA)).toEqual({ defaultModel: "opus" });
      expect(map.get(projectC)).toEqual({ defaultEffort: "low" });
      expect(map.has(projectB)).toBe(false);
    });
  });
});
