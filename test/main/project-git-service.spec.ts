import { beforeEach, describe, expect, it, vi } from "vitest";

const simpleGitFactoryMock = vi.hoisted(() => vi.fn());
const checkIsRepoMock = vi.hoisted(() => vi.fn());
const branchLocalMock = vi.hoisted(() => vi.fn());
const rawMock = vi.hoisted(() => vi.fn());
const readdirMock = vi.hoisted(() => vi.fn());
const writeProjectSettingsFileMock = vi.hoisted(() => vi.fn());

vi.mock("simple-git", () => ({
  default: simpleGitFactoryMock,
}));

vi.mock("node:fs/promises", () => ({
  readdir: readdirMock,
}));

vi.mock("../../src/main/project-settings-file", () => ({
  writeProjectSettingsFile: writeProjectSettingsFileMock,
}));

import { ProjectGitService } from "../../src/main/project-git-service";
import { defineProjectState } from "../../src/main/project-service";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

describe("ProjectGitService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    simpleGitFactoryMock.mockImplementation((projectPath: string) => ({
      checkIsRepo: () => checkIsRepoMock(projectPath),
      branchLocal: () => branchLocalMock(projectPath),
      raw: (args: string[]) => rawMock(projectPath, args),
    }));
    readdirMock.mockRejectedValue(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );
  });

  it("hydrates git branches for all tracked projects", async () => {
    const projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push(
        { path: "/repo-one", collapsed: false },
        { path: "/repo-two", collapsed: false },
      );
    });

    checkIsRepoMock.mockResolvedValue(true);
    branchLocalMock.mockImplementation(async (projectPath: string) => {
      if (projectPath === "/repo-one") {
        return { current: "main" };
      }
      return { current: null };
    });

    const service = new ProjectGitService(projectsState, {
      refreshIntervalMs: 60_000,
    });
    await service.refreshAll();

    expect(projectsState.state).toEqual([
      { path: "/repo-one", collapsed: false, gitBranch: "main" },
      { path: "/repo-two", collapsed: false, gitBranch: undefined },
    ]);
  });

  it("refreshes one project without touching the others", async () => {
    const projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push(
        { path: "/repo-one", collapsed: false, gitBranch: "main" },
        { path: "/repo-two", collapsed: false, gitBranch: "develop" },
      );
    });

    checkIsRepoMock.mockResolvedValue(true);
    branchLocalMock.mockResolvedValue({ current: "release" });

    const service = new ProjectGitService(projectsState, {
      refreshIntervalMs: 60_000,
    });
    await service.refreshProject("/repo-two");

    expect(projectsState.state).toEqual([
      { path: "/repo-one", collapsed: false, gitBranch: "main" },
      { path: "/repo-two", collapsed: false, gitBranch: "release" },
    ]);
    expect(simpleGitFactoryMock).toHaveBeenCalledWith("/repo-two");
    expect(checkIsRepoMock).toHaveBeenCalledWith("/repo-two");
    expect(branchLocalMock).toHaveBeenCalledWith("/repo-two");
  });

  it("skips branch lookup when the path is not a git repo", async () => {
    const projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push({ path: "/plain-dir", collapsed: false });
    });

    checkIsRepoMock.mockResolvedValue(false);

    const service = new ProjectGitService(projectsState, {
      refreshIntervalMs: 60_000,
    });
    await service.refreshProject("/plain-dir");

    expect(projectsState.state).toEqual([
      { path: "/plain-dir", collapsed: false },
    ]);
    expect(checkIsRepoMock).toHaveBeenCalledWith("/plain-dir");
    expect(branchLocalMock).not.toHaveBeenCalled();
  });

  it("starts refreshing in the background without blocking startup", async () => {
    const projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push({ path: "/repo-one", collapsed: false });
    });

    const repoOneBranch = createDeferred<{ current: string | null }>();
    checkIsRepoMock.mockResolvedValue(true);
    branchLocalMock.mockImplementation(async (projectPath: string) => {
      if (projectPath === "/repo-one") {
        return repoOneBranch.promise;
      }
      return { current: null };
    });

    const service = new ProjectGitService(projectsState, {
      refreshIntervalMs: 60_000,
    });

    service.start();

    expect(projectsState.state).toEqual([
      { path: "/repo-one", collapsed: false },
    ]);
    await vi.waitFor(() => {
      expect(branchLocalMock).toHaveBeenCalledWith("/repo-one");
    });

    repoOneBranch.resolve({ current: "main" });

    await vi.waitFor(() => {
      expect(projectsState.state).toEqual([
        { path: "/repo-one", collapsed: false, gitBranch: "main" },
      ]);
    });

    service.dispose();
  });

  it("does not clear a new project's branch when refreshAll finishes later", async () => {
    const projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push({ path: "/repo-one", collapsed: false });
    });

    const repoOneBranch = createDeferred<{ current: string | null }>();
    checkIsRepoMock.mockResolvedValue(true);
    branchLocalMock.mockImplementation(async (projectPath: string) => {
      if (projectPath === "/repo-one") {
        return repoOneBranch.promise;
      }
      if (projectPath === "/repo-two") {
        return { current: "feature/new-project" };
      }
      return { current: null };
    });

    const service = new ProjectGitService(projectsState, {
      refreshIntervalMs: 60_000,
    });

    const refreshAllPromise = service.refreshAll();
    await vi.waitFor(() => {
      expect(branchLocalMock).toHaveBeenCalledWith("/repo-one");
    });

    projectsState.updateState((projects) => {
      projects.push({ path: "/repo-two", collapsed: false });
    });
    await service.refreshProject("/repo-two");

    expect(projectsState.state).toEqual([
      { path: "/repo-one", collapsed: false },
      {
        path: "/repo-two",
        collapsed: false,
        gitBranch: "feature/new-project",
      },
    ]);

    repoOneBranch.resolve({ current: "main" });
    await refreshAllPromise;

    expect(projectsState.state).toEqual([
      { path: "/repo-one", collapsed: false, gitBranch: "main" },
      {
        path: "/repo-two",
        collapsed: false,
        gitBranch: "feature/new-project",
      },
    ]);
  });

  it("returns worktree creation data for local branches", async () => {
    checkIsRepoMock.mockResolvedValue(true);
    branchLocalMock.mockResolvedValue({
      current: "main",
      branches: {
        main: {},
        develop: {},
      },
    });

    const service = new ProjectGitService(defineProjectState(), {
      refreshIntervalMs: 60_000,
    });
    const result = await service.getWorktreeCreationData("/repo-one");

    expect(result).toEqual({
      currentBranch: "main",
      localBranches: ["develop", "main"],
      suggestedDestinationPath: "/repo-one-main",
      suggestedDestinationParentPath: "/",
      sourceProjectName: "repo-one",
    });
  });

  it("returns worktree creation data for detached HEAD repositories", async () => {
    checkIsRepoMock.mockResolvedValue(true);
    branchLocalMock.mockResolvedValue({
      current: "(no branch)",
      branches: {
        main: {},
        develop: {},
      },
    });

    const service = new ProjectGitService(defineProjectState(), {
      refreshIntervalMs: 60_000,
    });
    const result = await service.getWorktreeCreationData("/repo-one");

    expect(result).toEqual({
      currentBranch: "develop",
      localBranches: ["develop", "main"],
      suggestedDestinationPath: "/repo-one-develop",
      suggestedDestinationParentPath: "/",
      sourceProjectName: "repo-one",
    });
  });

  it("creates a worktree project with alias and origin metadata", async () => {
    const projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push({
        path: "/repo-one",
        collapsed: false,
        gitBranch: "main",
        localClaude: {
          defaultModel: "opus",
          defaultEffort: "high",
        },
        localCodex: {
          permissionMode: "yolo",
          modelReasoningEffort: "high",
        },
      });
    });

    checkIsRepoMock.mockResolvedValue(true);
    branchLocalMock.mockImplementation(async (projectPath: string) => {
      if (projectPath === "/repo-one") {
        return {
          current: "main",
          branches: {
            main: {},
            develop: {},
          },
        };
      }

      if (projectPath === "/repo-one-feature-new-ui") {
        return {
          current: "feature/new-ui",
          branches: {
            "feature/new-ui": {},
          },
        };
      }

      return { current: null, branches: {} };
    });

    const service = new ProjectGitService(projectsState, {
      refreshIntervalMs: 60_000,
    });
    const result = await service.createWorktreeProject({
      sourcePath: "/repo-one",
      fromBranch: "main",
      newBranch: "feature/new-ui",
      destinationPath: "/repo-one-feature-new-ui",
      alias: "UI Worktree",
    });

    expect(result).toEqual({ path: "/repo-one-feature-new-ui" });
    expect(rawMock).toHaveBeenCalledWith("/repo-one", [
      "worktree",
      "add",
      "-b",
      "feature/new-ui",
      "/repo-one-feature-new-ui",
      "main",
    ]);
    expect(writeProjectSettingsFileMock).toHaveBeenCalledWith(
      "/repo-one-feature-new-ui",
      {
        localClaude: {
          defaultModel: "opus",
          defaultEffort: "high",
        },
        localCodex: {
          permissionMode: "yolo",
          modelReasoningEffort: "high",
        },
        localCursor: undefined,
      },
    );
    expect(projectsState.state).toEqual([
      {
        path: "/repo-one",
        collapsed: false,
        gitBranch: "main",
        localClaude: {
          defaultModel: "opus",
          defaultEffort: "high",
        },
        localCodex: {
          permissionMode: "yolo",
          modelReasoningEffort: "high",
        },
      },
      {
        path: "/repo-one-feature-new-ui",
        collapsed: false,
        alias: "UI Worktree",
        worktreeOriginPath: "/repo-one",
        localClaude: {
          defaultModel: "opus",
          defaultEffort: "high",
        },
        localCodex: {
          permissionMode: "yolo",
          modelReasoningEffort: "high",
        },
        gitBranch: "feature/new-ui",
      },
    ]);
  });

  it("creates a worktree project from a detached HEAD repository", async () => {
    checkIsRepoMock.mockResolvedValue(true);
    branchLocalMock.mockImplementation(async (projectPath: string) => {
      if (projectPath === "/repo-one") {
        return {
          current: "(no branch)",
          branches: {
            main: {},
            develop: {},
          },
        };
      }

      if (projectPath === "/repo-one-feature-new-ui") {
        return {
          current: "feature/new-ui",
          branches: {
            "feature/new-ui": {},
          },
        };
      }

      return { current: null, branches: {} };
    });

    const service = new ProjectGitService(defineProjectState(), {
      refreshIntervalMs: 60_000,
    });

    await expect(
      service.createWorktreeProject({
        sourcePath: "/repo-one",
        fromBranch: "main",
        newBranch: "feature/new-ui",
        destinationPath: "/repo-one-feature-new-ui",
      }),
    ).resolves.toEqual({ path: "/repo-one-feature-new-ui" });

    expect(rawMock).toHaveBeenCalledWith("/repo-one", [
      "worktree",
      "add",
      "-b",
      "feature/new-ui",
      "/repo-one-feature-new-ui",
      "main",
    ]);
  });

  it("rejects worktree creation when the destination path is non-empty", async () => {
    checkIsRepoMock.mockResolvedValue(true);
    branchLocalMock.mockResolvedValue({
      current: "main",
      branches: {
        main: {},
      },
    });
    readdirMock.mockResolvedValue(["README.md"]);

    const service = new ProjectGitService(defineProjectState(), {
      refreshIntervalMs: 60_000,
    });

    await expect(
      service.createWorktreeProject({
        sourcePath: "/repo-one",
        fromBranch: "main",
        newBranch: "feature/new-ui",
        destinationPath: "/repo-one-feature-new-ui",
      }),
    ).rejects.toThrow("Destination path already exists and is not empty.");
  });

  it("removes a worktree folder and branch when requested", async () => {
    const projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push({
        path: "/repo-one-feature-new-ui",
        collapsed: false,
        gitBranch: "feature/new-ui",
        worktreeOriginPath: "/repo-one",
      });
    });

    const service = new ProjectGitService(projectsState, {
      refreshIntervalMs: 60_000,
    });
    const result = await service.deleteWorktreeProject({
      path: "/repo-one-feature-new-ui",
      deleteFolder: true,
      deleteBranch: true,
    });

    expect(result).toEqual({});
    expect(rawMock).toHaveBeenNthCalledWith(1, "/repo-one", [
      "worktree",
      "remove",
      "/repo-one-feature-new-ui",
    ]);
    expect(rawMock).toHaveBeenNthCalledWith(2, "/repo-one", [
      "branch",
      "-d",
      "feature/new-ui",
    ]);
  });

  it("returns a warning when branch deletion fails after worktree removal", async () => {
    const projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push({
        path: "/repo-one-feature-new-ui",
        collapsed: false,
        gitBranch: "feature/new-ui",
        worktreeOriginPath: "/repo-one",
      });
    });

    rawMock.mockImplementationOnce(async () => "");
    rawMock.mockImplementationOnce(async () => {
      throw new Error("branch is not fully merged");
    });

    const service = new ProjectGitService(projectsState, {
      refreshIntervalMs: 60_000,
    });
    const result = await service.deleteWorktreeProject({
      path: "/repo-one-feature-new-ui",
      deleteFolder: true,
      deleteBranch: true,
    });

    expect(result.warning).toContain(
      'deleting local branch "feature/new-ui" failed',
    );
    expect(result.warning).toContain("branch is not fully merged");
  });

  it("rejects deleting a worktree branch without deleting the folder", async () => {
    const projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push({
        path: "/repo-one-feature-new-ui",
        collapsed: false,
        gitBranch: "feature/new-ui",
        worktreeOriginPath: "/repo-one",
      });
    });

    const service = new ProjectGitService(projectsState, {
      refreshIntervalMs: 60_000,
    });

    await expect(
      service.deleteWorktreeProject({
        path: "/repo-one-feature-new-ui",
        deleteFolder: false,
        deleteBranch: true,
      }),
    ).rejects.toThrow(
      "Deleting a worktree branch also requires deleting the folder.",
    );
  });
});
