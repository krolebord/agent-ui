import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProjectScripts } from "../../src/main/package-scripts";
import { PROJECT_SCRIPTS_LIMIT } from "../../src/shared/project-commands";

describe("readProjectScripts", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(
      tmpdir(),
      `package-scripts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const writeManifest = async (manifest: Record<string, unknown>) => {
    await writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );
  };

  const writeLockfile = async () => {
    await writeFile(
      path.join(tempDir, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n",
      "utf-8",
    );
  };

  const writeSettings = async (settings: Record<string, unknown>) => {
    await mkdir(path.join(tempDir, ".agent-ui"), { recursive: true });
    await writeFile(
      path.join(tempDir, ".agent-ui", "settings.jsonc"),
      JSON.stringify(settings),
      "utf-8",
    );
  };

  it("returns nothing without a package.json", async () => {
    await writeLockfile();
    expect(await readProjectScripts(tempDir)).toEqual([]);
  });

  it("lists scripts as pnpm commands when a pnpm lockfile is present", async () => {
    await writeManifest({ scripts: { dev: "vite", test: "vitest run" } });
    await writeLockfile();

    expect(await readProjectScripts(tempDir)).toEqual([
      { id: "script:dev", name: "dev", run: "pnpm run dev" },
      { id: "script:test", name: "test", run: "pnpm run test" },
    ]);
  });

  it("accepts a pinned packageManager when the lockfile is not checked in", async () => {
    await writeManifest({
      packageManager: "pnpm@10.29.2",
      scripts: { build: "vite build" },
    });

    expect(await readProjectScripts(tempDir)).toEqual([
      { id: "script:build", name: "build", run: "pnpm run build" },
    ]);
  });

  it("returns nothing for a project on another package manager", async () => {
    await writeManifest({
      packageManager: "yarn@4.1.0",
      scripts: { build: "vite build" },
    });
    await writeFile(path.join(tempDir, "yarn.lock"), "", "utf-8");

    expect(await readProjectScripts(tempDir)).toEqual([]);
  });

  it("keeps declaration order and stops at the limit", async () => {
    const scripts: Record<string, string> = {};
    for (let index = 0; index < PROJECT_SCRIPTS_LIMIT + 5; index += 1) {
      scripts[`script-${index}`] = "true";
    }
    await writeManifest({ scripts });
    await writeLockfile();

    const result = await readProjectScripts(tempDir);
    expect(result).toHaveLength(PROJECT_SCRIPTS_LIMIT);
    expect(result[0]?.name).toBe("script-0");
    expect(result.at(-1)?.name).toBe(`script-${PROJECT_SCRIPTS_LIMIT - 1}`);
  });

  it("skips lifecycle hooks that shadow another script", async () => {
    await writeManifest({
      scripts: {
        prebuild: "rm -rf dist",
        build: "vite build",
        postbuild: "echo done",
        // Nothing named "flight", so this one stands on its own.
        preflight: "node check.js",
      },
    });
    await writeLockfile();

    expect(
      (await readProjectScripts(tempDir)).map((script) => script.name),
    ).toEqual(["build", "preflight"]);
  });

  it("skips names that would not survive being typed into a shell", async () => {
    await writeManifest({
      scripts: {
        "build:web": "vite build",
        "oops; rm -rf /": "true",
        "": "true",
        blank: "   ",
      },
    });
    await writeLockfile();

    expect(
      (await readProjectScripts(tempDir)).map((script) => script.name),
    ).toEqual(["build:web"]);
  });

  it("returns nothing when the project opts out", async () => {
    await writeManifest({ scripts: { dev: "vite" } });
    await writeLockfile();
    await writeSettings({ discoverCommands: false });

    expect(await readProjectScripts(tempDir)).toEqual([]);
  });

  it("returns nothing for a malformed manifest", async () => {
    await writeFile(path.join(tempDir, "package.json"), "{ oops", "utf-8");
    await writeLockfile();

    expect(await readProjectScripts(tempDir)).toEqual([]);
  });
});
