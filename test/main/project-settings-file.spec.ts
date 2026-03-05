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
    tempDir = await mkdir(
      path.join(tmpdir(), `project-settings-test-${Date.now()}`),
      {
        recursive: true,
      },
    ).then(() => path.join(tmpdir(), `project-settings-test-${Date.now()}`));
    // Use a fresh unique dir
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

    it("parses valid JSONC with comments", async () => {
      await mkdir(path.join(tempDir, ".agent-ui"), { recursive: true });
      await writeFile(
        settingsPath(),
        `{
  // Default settings for this project
  "localClaude": {
    "defaultModel": "sonnet",
    "defaultEffort": "high"
  },
  "localCodex": {
    "permissionMode": "full-auto",
    "modelReasoningEffort": "xhigh"
  }
}`,
        "utf-8",
      );

      const result = await readProjectSettingsFile(tempDir);
      expect(result).toEqual({
        localClaude: {
          defaultModel: "sonnet",
          defaultEffort: "high",
        },
        localCodex: {
          permissionMode: "full-auto",
          modelReasoningEffort: "xhigh",
        },
      });
    });

    it("handles invalid JSON gracefully", async () => {
      await mkdir(path.join(tempDir, ".agent-ui"), { recursive: true });
      await writeFile(settingsPath(), "not json at all {{{", "utf-8");

      const result = await readProjectSettingsFile(tempDir);
      expect(result).toBeNull();
    });

    it("uses .catch(undefined) for unknown enum values", async () => {
      await mkdir(path.join(tempDir, ".agent-ui"), { recursive: true });
      await writeFile(
        settingsPath(),
        `{
  "localClaude": {
    "defaultModel": "unknown-model-xyz",
    "defaultEffort": "high"
  },
  "localCodex": {
    "permissionMode": "not-a-mode",
    "modelReasoningEffort": "low"
  }
}`,
        "utf-8",
      );

      const result = await readProjectSettingsFile(tempDir);
      expect(result).toEqual({
        localClaude: {
          defaultModel: undefined,
          defaultEffort: "high",
        },
        localCodex: {
          permissionMode: undefined,
          modelReasoningEffort: "low",
        },
      });
    });

    it("strips unknown keys", async () => {
      await mkdir(path.join(tempDir, ".agent-ui"), { recursive: true });
      await writeFile(
        settingsPath(),
        `{
  "localClaude": { "defaultModel": "opus", "unknownKey": true },
  "unknownTopLevel": true
}`,
        "utf-8",
      );

      const result = await readProjectSettingsFile(tempDir);
      expect(result).toEqual({
        localClaude: { defaultModel: "opus" },
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
        localClaude: {
          defaultModel: "sonnet",
          defaultEffort: "high",
        },
        localCodex: {
          permissionMode: "yolo",
          modelReasoningEffort: "high",
        },
      });

      expect(existsSync(settingsPath())).toBe(true);
      const content = readFileSync(settingsPath(), "utf-8");
      expect(content).toContain('"localClaude"');
      expect(content).toContain('"defaultModel": "sonnet"');
      expect(content).toContain('"defaultEffort": "high"');
      expect(content).toContain('"localCodex"');
      expect(content).toContain('"permissionMode": "yolo"');
      expect(content).toContain('"modelReasoningEffort": "high"');
    });

    it("preserves existing comments on re-write", async () => {
      await mkdir(path.join(tempDir, ".agent-ui"), { recursive: true });
      const original = `{
  // This is a project comment
  "localClaude": {
    "defaultModel": "sonnet",
    "defaultEffort": "low"
  }
}`;
      await writeFile(settingsPath(), original, "utf-8");

      await writeProjectSettingsFile(tempDir, {
        localClaude: {
          defaultModel: "opus",
          defaultEffort: "high",
        },
      });

      const content = readFileSync(settingsPath(), "utf-8");
      expect(content).toContain("// This is a project comment");
      expect(content).toContain('"defaultModel": "opus"');
      expect(content).toContain('"defaultEffort": "high"');
    });

    it("removes keys set to undefined and prunes empty groups", async () => {
      await writeProjectSettingsFile(tempDir, {
        localClaude: {
          defaultModel: "sonnet",
          defaultEffort: "high",
        },
        localCodex: {
          permissionMode: "default",
          modelReasoningEffort: "high",
        },
      });

      await writeProjectSettingsFile(tempDir, {
        localClaude: undefined,
        localCodex: {
          permissionMode: "default",
          modelReasoningEffort: "high",
        },
      });

      const content = readFileSync(settingsPath(), "utf-8");
      expect(content).not.toContain("defaultModel");
      expect(content).not.toContain("localClaude");
      expect(content).toContain('"localCodex"');
    });

    it("removes legacy flat keys on write", async () => {
      await mkdir(path.join(tempDir, ".agent-ui"), { recursive: true });
      await writeFile(
        settingsPath(),
        `{
  "defaultModel": "opus",
  "defaultEffort": "high",
  "localCodex": {
    "permissionMode": "default"
  }
}`,
        "utf-8",
      );

      await writeProjectSettingsFile(tempDir, {
        localClaude: {
          defaultModel: "sonnet",
        },
      });

      const content = readFileSync(settingsPath(), "utf-8");
      expect(content).not.toContain('"defaultModel": "opus"');
      expect(content).not.toContain('"defaultEffort": "high"');
      expect(content).toContain('"localClaude"');
      expect(content).toContain('"defaultModel": "sonnet"');
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
        '{ "localClaude": { "defaultModel": "opus" } }',
        "utf-8",
      );

      await mkdir(projectB, { recursive: true });
      // project-b has no settings file

      await mkdir(path.join(projectC, ".agent-ui"), { recursive: true });
      await writeFile(
        path.join(projectC, ".agent-ui", "settings.jsonc"),
        '{ "localCodex": { "permissionMode": "yolo" } }',
        "utf-8",
      );

      const map = await readProjectSettingsForAll([
        projectA,
        projectB,
        projectC,
      ]);

      expect(map.size).toBe(2);
      expect(map.get(projectA)).toEqual({
        localClaude: { defaultModel: "opus" },
      });
      expect(map.get(projectC)).toEqual({
        localCodex: { permissionMode: "yolo" },
      });
      expect(map.has(projectB)).toBe(false);
    });
  });
});
