import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ensureManagedCursorStateHooks } from "../../src/main/cursor-state-hooks";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

afterEach(async () => {
  process.env.HOME = originalHome;
});

afterAll(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("ensureManagedCursorStateHooks", () => {
  it("creates managed hook config, state file, and user hooks config", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "cursor-state-hooks-test-"),
    );
    const homePath = await mkdtemp(path.join(tmpdir(), "cursor-home-test-"));
    tempDirs.push(userDataPath);
    tempDirs.push(homePath);
    process.env.HOME = homePath;
    await mkdir(path.join(homePath, "Library", "Logs", "claude-ui"), {
      recursive: true,
    });

    const managed = await ensureManagedCursorStateHooks(userDataPath);
    const hooksConfigRaw = await readFile(
      path.join(managed.configDir, "hooks.json"),
      "utf8",
    );
    const script = await readFile(
      path.join(managed.configDir, "hooks", "emit-state.mjs"),
      "utf8",
    );
    const userHooksRaw = await readFile(
      path.join(homePath, ".cursor", "hooks.json"),
      "utf8",
    );
    const stateFileRaw = await readFile(managed.eventsFilePath, "utf8");

    const hooksConfig = JSON.parse(hooksConfigRaw) as {
      version: number;
      hooks: Record<string, Array<{ command: string }>>;
    };
    const userHooksConfig = JSON.parse(userHooksRaw) as {
      hooks: Record<string, Array<{ command: string }>>;
    };

    expect(hooksConfig.version).toBe(1);
    expect(hooksConfig.hooks.preToolUse?.length).toBe(1);
    expect(hooksConfig.hooks.sessionStart?.length).toBe(1);
    expect(hooksConfig.hooks.stop?.length).toBe(1);
    expect(userHooksConfig.hooks.preToolUse?.length).toBe(1);
    expect(userHooksConfig.hooks.sessionStart?.length).toBe(1);
    expect(userHooksConfig.hooks.stop?.length).toBe(1);
    expect(userHooksConfig.hooks.sessionStart?.[0]?.command).toContain(
      "emit-state.mjs",
    );
    expect(script).toContain("hook_event_name");
    expect(script).toContain("eventsFilePath");
    expect(stateFileRaw).toBe("");
  });

  it("merges managed hooks with existing user hooks without duplicates", async () => {
    const userDataPath = await mkdtemp(
      path.join(tmpdir(), "cursor-state-hooks-merge-test-"),
    );
    const homePath = await mkdtemp(
      path.join(tmpdir(), "cursor-home-merge-test-"),
    );
    tempDirs.push(userDataPath);
    tempDirs.push(homePath);
    process.env.HOME = homePath;
    await mkdir(path.join(homePath, "Library", "Logs", "claude-ui"), {
      recursive: true,
    });

    const managedScriptPath = path.join(
      userDataPath,
      "cursor-hooks",
      "config",
      "hooks",
      "emit-state.mjs",
    );
    // Use a different runtime than what detectHookRuntime may return,
    // to verify that stale commands are replaced on runtime change.
    const staleCommand = `node "${managedScriptPath}"`;

    const userHooksPath = path.join(homePath, ".cursor", "hooks.json");
    const existingHooksConfig = {
      hooks: {
        sessionStart: [
          { command: "echo keep-existing", timeout: 5 },
          { command: staleCommand, timeout: 5 },
        ],
        beforeReadFile: [{ command: "echo keep-before-read", timeout: 5 }],
      },
    };

    await mkdir(path.dirname(userHooksPath), { recursive: true });
    await writeFile(
      userHooksPath,
      `${JSON.stringify(existingHooksConfig, null, 2)}\n`,
      "utf8",
    );

    await ensureManagedCursorStateHooks(userDataPath);

    const mergedRaw = await readFile(userHooksPath, "utf8");
    const mergedConfig = JSON.parse(mergedRaw) as {
      hooks: Record<string, Array<{ command: string }>>;
    };

    const sessionStartCommands =
      mergedConfig.hooks.sessionStart?.map((entry) => entry.command) ?? [];
    expect(sessionStartCommands).toContain("echo keep-existing");
    expect(
      sessionStartCommands.filter((cmd) => cmd.includes(managedScriptPath))
        .length,
    ).toBe(1);

    const beforeReadFileCommands =
      mergedConfig.hooks.beforeReadFile?.map((entry) => entry.command) ?? [];
    expect(beforeReadFileCommands).toContain("echo keep-before-read");
    expect(
      beforeReadFileCommands.filter((cmd) => cmd.includes(managedScriptPath))
        .length,
    ).toBe(1);
  });
});
