import { beforeEach, describe, expect, it, vi } from "vitest";

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
