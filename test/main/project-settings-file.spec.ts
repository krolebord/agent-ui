import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readProjectCommands,
  readProjectSettingsFile,
  readProjectSettingsForAll,
  writeProjectCommands,
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

    it("allows trailing commas", async () => {
      await mkdir(path.join(tempDir, ".agent-ui"), { recursive: true });
      await writeFile(
        settingsPath(),
        `{
  "iconPath": "brand/logo.png",
  "worktreeSetupCommands": "pnpm install",
}`,
        "utf-8",
      );

      const result = await readProjectSettingsFile(tempDir);
      expect(result).toEqual({
        iconPath: "brand/logo.png",
        worktreeSetupCommands: "pnpm install",
      });
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

  describe("readProjectCommands", () => {
    const writeSettings = async (content: string) => {
      await mkdir(path.join(tempDir, ".agent-ui"), { recursive: true });
      await writeFile(settingsPath(), content, "utf-8");
    };

    it("returns an empty list when the file has no commands", async () => {
      await writeSettings(`{ "worktreeSetupCommands": "pnpm install" }`);

      expect(await readProjectCommands(tempDir)).toEqual([]);
    });

    it("derives ids from names and keeps explicit ones", async () => {
      await writeSettings(`{
  "commands": [
    { "name": "Dev server", "run": "just dev" },
    { "id": "e2e", "name": "E2E tests", "run": "just e2e", "singleton": true }
  ]
}`);

      const commands = await readProjectCommands(tempDir);
      expect(commands).toEqual([
        {
          id: "dev-server",
          explicitId: undefined,
          name: "Dev server",
          run: "just dev",
          sourceIndex: 0,
        },
        {
          id: "e2e",
          explicitId: "e2e",
          name: "E2E tests",
          run: "just e2e",
          singleton: true,
          sourceIndex: 1,
        },
      ]);
    });

    it("skips malformed entries and disambiguates duplicate ids", async () => {
      await writeSettings(`{
  "commands": [
    { "name": "Dev", "run": "just dev" },
    { "name": "No run command" },
    "nonsense",
    { "name": "Dev", "run": "just dev --debug" }
  ]
}`);

      const commands = await readProjectCommands(tempDir);
      expect(
        commands.map((command) => [command.id, command.sourceIndex]),
      ).toEqual([
        ["dev", 0],
        ["dev-2", 3],
      ]);
    });
  });

  describe("writeProjectCommands", () => {
    const writeSettings = async (content: string) => {
      await mkdir(path.join(tempDir, ".agent-ui"), { recursive: true });
      await writeFile(settingsPath(), content, "utf-8");
    };

    it("creates the commands array alongside existing settings", async () => {
      await writeSettings(`{
  // Keep me
  "worktreeSetupCommands": "pnpm install"
}`);

      await writeProjectCommands(tempDir, [
        { name: "Dev server", run: "just dev", singleton: true },
      ]);

      const content = readFileSync(settingsPath(), "utf-8");
      expect(content).toContain("// Keep me");
      expect(content).toContain('"worktreeSetupCommands": "pnpm install"');
      expect(await readProjectCommands(tempDir)).toMatchObject([
        { id: "dev-server", name: "Dev server", run: "just dev" },
      ]);
    });

    it("edits one entry without disturbing comments on the others", async () => {
      await writeSettings(`{
  "commands": [
    // The one we never remember
    { "name": "Dev server", "run": "just dev" },
    { "name": "E2E tests", "run": "just e2e" }
  ]
}`);

      await writeProjectCommands(tempDir, [
        { name: "Dev server", run: "just dev", sourceIndex: 0 },
        { name: "E2E tests", run: "just e2e --headed", sourceIndex: 1 },
      ]);

      const content = readFileSync(settingsPath(), "utf-8");
      expect(content).toContain("// The one we never remember");
      expect(content).toContain('"run": "just e2e --headed"');
      expect(await readProjectCommands(tempDir)).toMatchObject([
        { name: "Dev server", run: "just dev" },
        { name: "E2E tests", run: "just e2e --headed" },
      ]);
    });

    it("deletes removed entries and appends new ones", async () => {
      await writeSettings(`{
  "commands": [
    { "name": "Dev server", "run": "just dev" },
    { "name": "E2E tests", "run": "just e2e" }
  ]
}`);

      await writeProjectCommands(tempDir, [
        { name: "Dev server", run: "just dev", sourceIndex: 0 },
        { name: "Deploy", run: "just deploy" },
      ]);

      expect(await readProjectCommands(tempDir)).toMatchObject([
        { name: "Dev server", run: "just dev" },
        { name: "Deploy", run: "just deploy" },
      ]);
    });

    it("drops the key when the last command is removed", async () => {
      await writeSettings(`{
  "worktreeSetupCommands": "pnpm install",
  "commands": [{ "name": "Dev server", "run": "just dev" }]
}`);

      await writeProjectCommands(tempDir, []);

      const content = readFileSync(settingsPath(), "utf-8");
      expect(content).not.toContain("commands");
      expect(content).toContain('"worktreeSetupCommands": "pnpm install"');
    });

    it("keeps malformed entries the app cannot see", async () => {
      await writeSettings(`{
  "commands": [
    { "name": "Broken" },
    { "name": "Dev server", "run": "just dev" }
  ]
}`);

      await writeProjectCommands(tempDir, []);

      const content = readFileSync(settingsPath(), "utf-8");
      expect(content).toContain('"name": "Broken"');
      expect(content).not.toContain("Dev server");
    });

    it("refuses to reorder entries", async () => {
      await writeSettings(`{
  "commands": [
    { "name": "Dev server", "run": "just dev" },
    { "name": "E2E tests", "run": "just e2e" }
  ]
}`);

      await expect(
        writeProjectCommands(tempDir, [
          { name: "E2E tests", run: "just e2e", sourceIndex: 1 },
          { name: "Dev server", run: "just dev", sourceIndex: 0 },
        ]),
      ).rejects.toThrow(/Reordering/);
    });

    it("leaves an unparseable file untouched", async () => {
      const broken = `{ "commands": [ }`;
      await writeSettings(broken);

      await expect(
        writeProjectCommands(tempDir, [{ name: "Dev", run: "just dev" }]),
      ).rejects.toThrow(/could not be parsed/);
      expect(readFileSync(settingsPath(), "utf-8")).toBe(broken);
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
