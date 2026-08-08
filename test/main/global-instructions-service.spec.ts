import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { composeInstructionFile } from "@shared/global-instructions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../../src/main/database/database-service";
import {
  GlobalInstructionsService,
  resolveGlobalInstructionPaths,
  SqliteGlobalInstructionsStore,
} from "../../src/main/global-instructions-service";

describe("composeInstructionFile", () => {
  it("joins common and override with a blank line", () => {
    expect(composeInstructionFile("common prefs", "claude only")).toBe(
      "common prefs\n\nclaude only\n",
    );
  });

  it("omits empty sections", () => {
    expect(composeInstructionFile("common only", "")).toBe("common only\n");
    expect(composeInstructionFile("", "override only")).toBe("override only\n");
    expect(composeInstructionFile("  ", "\n")).toBe("");
  });
});

describe("resolveGlobalInstructionPaths", () => {
  it("defaults to ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md", () => {
    expect(resolveGlobalInstructionPaths("claude", "/home/agent", {})).toEqual({
      absolutePath: path.join("/home/agent", ".claude", "CLAUDE.md"),
      directoryPath: path.join("/home/agent", ".claude"),
      displayPath: "~/.claude/CLAUDE.md",
    });
    expect(resolveGlobalInstructionPaths("codex", "/home/agent", {})).toEqual({
      absolutePath: path.join("/home/agent", ".codex", "AGENTS.md"),
      directoryPath: path.join("/home/agent", ".codex"),
      displayPath: "~/.codex/AGENTS.md",
    });
  });

  it("honors CLAUDE_CONFIG_DIR and CODEX_HOME", () => {
    expect(
      resolveGlobalInstructionPaths("claude", "/home/agent", {
        CLAUDE_CONFIG_DIR: "/custom/claude",
      }),
    ).toMatchObject({
      absolutePath: path.join("/custom/claude", "CLAUDE.md"),
      directoryPath: "/custom/claude",
      displayPath: path.join("/custom/claude", "CLAUDE.md"),
    });
    expect(
      resolveGlobalInstructionPaths("codex", "/home/agent", {
        CODEX_HOME: "/custom/codex",
      }),
    ).toMatchObject({
      absolutePath: path.join("/custom/codex", "AGENTS.md"),
      directoryPath: "/custom/codex",
    });
  });
});

describe("GlobalInstructionsService", () => {
  const tempDirs: string[] = [];

  async function createService() {
    const userDataPath = await mkdtemp(
      path.join(os.tmpdir(), "agent-ui-global-instr-"),
    );
    const homeDir = await mkdtemp(
      path.join(os.tmpdir(), "agent-ui-global-home-"),
    );
    tempDirs.push(userDataPath, homeDir);

    const databaseService = await DatabaseService.create(userDataPath);
    const service = new GlobalInstructionsService({
      store: new SqliteGlobalInstructionsStore(databaseService.db),
      homeDir,
      env: {},
    });

    return { service, homeDir, databaseService };
  }

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("returns empty content without importing existing files", async () => {
    const { service, homeDir, databaseService } = await createService();
    const existingPath = path.join(homeDir, ".claude", "CLAUDE.md");
    await mkdir(path.dirname(existingPath), { recursive: true });
    await writeFile(existingPath, "do not import this", "utf8");

    const snapshot = await service.getSnapshot();
    expect(snapshot.common).toBe("");
    expect(snapshot.overrides).toEqual({ claude: "", codex: "" });
    expect(snapshot.updatedAt).toBeNull();
    expect(await readFile(existingPath, "utf8")).toBe("do not import this");

    await databaseService.close();
  });

  it("saves common + overrides and overwrites both harness files", async () => {
    const { service, homeDir, databaseService } = await createService();
    const claudePath = path.join(homeDir, ".claude", "CLAUDE.md");
    const codexPath = path.join(homeDir, ".codex", "AGENTS.md");
    await mkdir(path.dirname(claudePath), { recursive: true });
    await mkdir(path.dirname(codexPath), { recursive: true });
    await writeFile(claudePath, "old claude", "utf8");
    await writeFile(codexPath, "old codex", "utf8");

    const saved = await service.save({
      common: "shared prefs",
      overrides: {
        claude: "claude only",
        codex: "",
      },
    });

    expect(saved.common).toBe("shared prefs");
    expect(saved.overrides.claude).toBe("claude only");
    expect(saved.overrides.codex).toBe("");
    expect(await readFile(claudePath, "utf8")).toBe(
      "shared prefs\n\nclaude only\n",
    );
    expect(await readFile(codexPath, "utf8")).toBe("shared prefs\n");
    expect(
      saved.harnesses.every((harness) => harness.lastPushedAt != null),
    ).toBe(true);

    await databaseService.close();
  });

  it("creates parent directories when missing", async () => {
    const { service, homeDir, databaseService } = await createService();
    const targetPath = path.join(homeDir, ".claude", "CLAUDE.md");

    await service.save({
      common: "# prefs\n",
      overrides: { claude: "", codex: "" },
    });

    expect(await readFile(targetPath, "utf8")).toBe("# prefs\n");
    await databaseService.close();
  });

  it("persists content across service instances", async () => {
    const userDataPath = await mkdtemp(
      path.join(os.tmpdir(), "agent-ui-global-instr-"),
    );
    const homeDir = await mkdtemp(
      path.join(os.tmpdir(), "agent-ui-global-home-"),
    );
    tempDirs.push(userDataPath, homeDir);

    const firstDb = await DatabaseService.create(userDataPath);
    const first = new GlobalInstructionsService({
      store: new SqliteGlobalInstructionsStore(firstDb.db),
      homeDir,
      env: {},
    });
    await first.save({
      common: "persisted",
      overrides: { claude: "c", codex: "x" },
    });
    await firstDb.close();

    const secondDb = await DatabaseService.create(userDataPath);
    const second = new GlobalInstructionsService({
      store: new SqliteGlobalInstructionsStore(secondDb.db),
      homeDir,
      env: {},
      writeFile: vi.fn(async () => {
        throw new Error("should not write on get");
      }),
    });
    const snapshot = await second.getSnapshot();
    expect(snapshot.common).toBe("persisted");
    expect(snapshot.overrides).toEqual({ claude: "c", codex: "x" });
    await secondDb.close();
  });
});
