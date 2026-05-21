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
    tempDir = path.join(
      tmpdir(),
      `project-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const settingsPath = () => path.join(tempDir, ".agent-ui", "settings.jsonc");

  describe("readProjectSettingsFile", () => {
    it("returns null for missing file", async () => {
      const result = await readProjectSettingsFile(tempDir);
      expect(result).toBeNull();
    });

    it("parses worktree setup commands and ignores session settings", async () => {
      await mkdir(path.join(tempDir, ".agent-ui"), { recursive: true });
      await writeFile(
        settingsPath(),
        `{
  // Worktree setup for this project
  "worktreeSetupCommands": "pnpm install",
  "localClaude": {
    "defaultModel": "sonnet",
    "defaultEffort": "high"
  },
  "localCodex": {
    "permissionMode": "full-auto"
  }
}`,
        "utf-8",
      );

      const result = await readProjectSettingsFile(tempDir);
      expect(result).toEqual({
        worktreeSetupCommands: "pnpm install",
      });
    });

    it("handles invalid JSON gracefully", async () => {
      await mkdir(path.join(tempDir, ".agent-ui"), { recursive: true });
      await writeFile(settingsPath(), "not json at all {{{", "utf-8");

      const result = await readProjectSettingsFile(tempDir);
      expect(result).toBeNull();
    });

    it("strips unknown keys", async () => {
      await mkdir(path.join(tempDir, ".agent-ui"), { recursive: true });
      await writeFile(
        settingsPath(),
        `{
  "worktreeSetupCommands": "pnpm install",
  "unknownTopLevel": true
}`,
        "utf-8",
      );

      const result = await readProjectSettingsFile(tempDir);
      expect(result).toEqual({
        worktreeSetupCommands: "pnpm install",
      });
      expect(result).not.toHaveProperty("unknownTopLevel");
    });

    it("ignores legacy flat settings schema", async () => {
      await mkdir(path.join(tempDir, ".agent-ui"), { recursive: true });
      await writeFile(
        settingsPath(),
        `{ "defaultModel": "opus", "defaultEffort": "high" }`,
        "utf-8",
      );

      const result = await readProjectSettingsFile(tempDir);
      expect(result).toEqual({});
    });
  });

  describe("writeProjectSettingsFile", () => {
    it("creates .agent-ui directory and file", async () => {
      await writeProjectSettingsFile(tempDir, {
        worktreeSetupCommands: "pnpm install",
      });

      expect(existsSync(settingsPath())).toBe(true);
      const content = readFileSync(settingsPath(), "utf-8");
      expect(content).toContain('"worktreeSetupCommands": "pnpm install"');
    });

    it("preserves existing comments on re-write", async () => {
      await mkdir(path.join(tempDir, ".agent-ui"), { recursive: true });
      const original = `{
  // This is a project comment
  "worktreeSetupCommands": "pnpm install"
}`;
      await writeFile(settingsPath(), original, "utf-8");

      await writeProjectSettingsFile(tempDir, {
        worktreeSetupCommands: "pnpm build",
      });

      const content = readFileSync(settingsPath(), "utf-8");
      expect(content).toContain("// This is a project comment");
      expect(content).toContain('"worktreeSetupCommands": "pnpm build"');
    });

    it("removes worktree setup commands when cleared", async () => {
      await writeProjectSettingsFile(tempDir, {
        worktreeSetupCommands: "pnpm install",
      });

      await writeProjectSettingsFile(tempDir, {});

      const content = readFileSync(settingsPath(), "utf-8");
      expect(content).not.toContain("worktreeSetupCommands");
    });

    it("removes legacy session settings keys on write", async () => {
      await mkdir(path.join(tempDir, ".agent-ui"), { recursive: true });
      await writeFile(
        settingsPath(),
        `{
  "defaultModel": "opus",
  "localClaude": {
    "defaultModel": "sonnet"
  },
  "localCodex": {
    "permissionMode": "default"
  },
  "worktreeSetupCommands": "pnpm install"
}`,
        "utf-8",
      );

      await writeProjectSettingsFile(tempDir, {
        worktreeSetupCommands: "pnpm build",
      });

      const content = readFileSync(settingsPath(), "utf-8");
      expect(content).not.toContain("defaultModel");
      expect(content).not.toContain("localClaude");
      expect(content).not.toContain("localCodex");
      expect(content).toContain('"worktreeSetupCommands": "pnpm build"');
    });
  });

  describe("readProjectSettingsForAll", () => {
    it("returns settings for projects that have files", async () => {
      const projectA = path.join(tempDir, "project-a");
      const projectB = path.join(tempDir, "project-b");
      const projectC = path.join(tempDir, "project-c");

      await mkdir(path.join(projectA, ".agent-ui"), { recursive: true });
      await writeFile(
        path.join(projectA, ".agent-ui", "settings.jsonc"),
        '{ "worktreeSetupCommands": "pnpm install" }',
        "utf-8",
      );

      await mkdir(projectB, { recursive: true });

      await mkdir(path.join(projectC, ".agent-ui"), { recursive: true });
      await writeFile(
        path.join(projectC, ".agent-ui", "settings.jsonc"),
        '{ "worktreeSetupCommands": "pnpm build" }',
        "utf-8",
      );

      const map = await readProjectSettingsForAll([
        projectA,
        projectB,
        projectC,
      ]);

      expect(map.size).toBe(2);
      expect(map.get(projectA)).toEqual({
        worktreeSetupCommands: "pnpm install",
      });
      expect(map.get(projectC)).toEqual({
        worktreeSetupCommands: "pnpm build",
      });
      expect(map.has(projectB)).toBe(false);
    });
  });
});
