import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppHost } from "../../src/main/app-host";
import type { Services } from "../../src/main/create-services";

const shellMock = vi.hoisted(() => ({
  openPath: vi.fn<(targetPath: string) => Promise<string>>(),
}));

const appMock = vi.hoisted(() => ({
  getPath: vi.fn<(name: string) => string>(),
}));

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  app: appMock,
  dialog: {
    showOpenDialog: vi.fn(),
  },
  shell: shellMock,
}));

vi.mock("nano-spawn", () => ({
  default: spawnMock,
}));

import { createElectronHost } from "../../src/main/electron-host";
import {
  browseDirectories,
  fsRouter,
  openFolderInAppInputSchema,
} from "../../src/main/fs.router";

function createDesktopHost() {
  const desktop = createElectronHost({ getMainWindow: () => null }).desktop;
  if (!desktop) {
    throw new Error("Expected Electron desktop host");
  }
  return desktop;
}

describe("fs.router openFolderInApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appMock.getPath.mockReturnValue("/tmp/agent-ui");
    shellMock.openPath.mockResolvedValue("");
    spawnMock.mockResolvedValue({
      output: "",
      stdout: "",
      stderr: "",
    });
  });

  it("opens Finder with Electron shell", async () => {
    await createDesktopHost().openFolderInApp("/tmp/project", "finder");

    expect(shellMock.openPath).toHaveBeenCalledWith("/tmp/project");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("opens supported apps with macOS open -a", async () => {
    const desktop = createDesktopHost();
    await desktop.openFolderInApp("/tmp/project", "cursor");
    await desktop.openFolderInApp("/tmp/project", "github-desktop");
    await desktop.openFolderInApp("/tmp/project", "terminal");

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
      createDesktopHost().openFolderInApp("/tmp/project", "finder"),
    ).rejects.toThrow("Failed to open folder in Finder: App not found");
  });

  it("wraps app launcher failures with the target app name", async () => {
    spawnMock.mockRejectedValue(new Error("Launch failed"));

    await expect(
      createDesktopHost().openFolderInApp("/tmp/project", "github-desktop"),
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

describe("fs.router desktop capabilities", () => {
  it("rejects desktop-only procedures in headless mode", async () => {
    const host: AppHost = {
      mode: "headless",
      paths: { userData: "/tmp/agent-ui", logs: "/tmp/agent-ui/logs" },
      desktop: null,
    };

    await expect(
      call(
        fsRouter.openFolder,
        { path: "/tmp/project" },
        { context: { host } as Services },
      ),
    ).rejects.toMatchObject({
      code: "METHOD_NOT_SUPPORTED",
      message: "This operation is only available in the Electron app.",
    });
  });
});
