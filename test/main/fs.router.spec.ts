import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shellMock = vi.hoisted(() => ({
  openPath: vi.fn<(targetPath: string) => Promise<string>>(),
}));

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  shell: shellMock,
}));

vi.mock("nano-spawn", () => ({
  default: spawnMock,
}));

import {
  browseDirectories,
  openFolderInApp,
  openFolderInAppInputSchema,
} from "../../src/main/fs.router";

describe("fs.router openFolderInApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shellMock.openPath.mockResolvedValue("");
    spawnMock.mockResolvedValue({
      output: "",
      stdout: "",
      stderr: "",
    });
  });

  it("opens Finder with Electron shell", async () => {
    await openFolderInApp({
      path: "/tmp/project",
      app: "finder",
    });

    expect(shellMock.openPath).toHaveBeenCalledWith("/tmp/project");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("opens supported apps with macOS open -a", async () => {
    await openFolderInApp({
      path: "/tmp/project",
      app: "cursor",
    });
    await openFolderInApp({
      path: "/tmp/project",
      app: "github-desktop",
    });
    await openFolderInApp({
      path: "/tmp/project",
      app: "terminal",
    });

    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      "open",
      ["-a", "Cursor", "/tmp/project"],
      { stdin: "ignore" },
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      "open",
      ["-a", "GitHub Desktop", "/tmp/project"],
      { stdin: "ignore" },
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      3,
      "open",
      ["-a", "Terminal", "/tmp/project"],
      { stdin: "ignore" },
    );
  });

  it("surfaces Finder launch failures", async () => {
    shellMock.openPath.mockResolvedValue("App not found");

    await expect(
      openFolderInApp({
        path: "/tmp/project",
        app: "finder",
      }),
    ).rejects.toThrow("Failed to open folder in Finder: App not found");
  });

  it("wraps app launcher failures with the target app name", async () => {
    spawnMock.mockRejectedValue(new Error("Launch failed"));

    await expect(
      openFolderInApp({
        path: "/tmp/project",
        app: "github-desktop",
      }),
    ).rejects.toThrow("Failed to open folder in GitHub Desktop: Launch failed");
  });

  it("validates non-empty paths and known target apps", () => {
    expect(() =>
      openFolderInAppInputSchema.parse({
        path: "   ",
        app: "finder",
      }),
    ).toThrow();

    expect(() =>
      openFolderInAppInputSchema.parse({
        path: "/tmp/project",
        app: "invalid-app",
      }),
    ).toThrow();
  });
});

describe("fs.router browseDirectories", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-ui-fs-router-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns matching directories and excludes files", async () => {
    await mkdir(path.join(tempDir, "alpha"));
    await mkdir(path.join(tempDir, "alpine"));
    await writeFile(path.join(tempDir, "alphabet.txt"), "ignore me");

    const result = await browseDirectories({
      partialPath: path.join(tempDir, "alp"),
    });

    expect(result).toEqual({
      parentPath: tempDir,
      entries: [
        { name: "alpha", fullPath: path.join(tempDir, "alpha") },
        { name: "alpine", fullPath: path.join(tempDir, "alpine") },
      ],
    });
  });

  it("shows hidden directories in directory mode and hidden-prefix mode", async () => {
    await mkdir(path.join(tempDir, ".config"));
    await mkdir(path.join(tempDir, "config"));

    const directoryResult = await browseDirectories({
      partialPath: `${tempDir}${path.sep}`,
    });
    const hiddenPrefixResult = await browseDirectories({
      partialPath: path.join(tempDir, ".c"),
    });

    expect(directoryResult.entries.map((entry) => entry.name)).toEqual([
      ".config",
      "config",
    ]);
    expect(hiddenPrefixResult).toEqual({
      parentPath: tempDir,
      entries: [{ name: ".config", fullPath: path.join(tempDir, ".config") }],
    });
  });

  it("resolves explicit relative paths against cwd", async () => {
    await mkdir(path.join(tempDir, "packages"));

    const result = await browseDirectories({
      cwd: tempDir,
      partialPath: "./pack",
    });

    expect(result).toEqual({
      parentPath: tempDir,
      entries: [{ name: "packages", fullPath: path.join(tempDir, "packages") }],
    });
  });
});
