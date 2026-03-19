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
    rawMock.mockImplementation(async (_projectPath: string, args: string[]) => {
      if (args[0] === "rev-parse") {
        return "0123456789abcdef\n";
      }
      return "";
    });
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
      {
        path: "/repo-one",
        collapsed: false,
        gitBranch: "main",
        gitDiffStats: { addedLines: 0, deletedLines: 0 },
      },
      {
        path: "/repo-two",
        collapsed: false,
        gitBranch: undefined,
        gitDiffStats: { addedLines: 0, deletedLines: 0 },
      },
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
      {
        path: "/repo-two",
        collapsed: false,
        gitBranch: "release",
        gitDiffStats: { addedLines: 0, deletedLines: 0 },
      },
    ]);
    expect(simpleGitFactoryMock).toHaveBeenCalledWith("/repo-two");
    expect(checkIsRepoMock).toHaveBeenCalledWith("/repo-two");
    expect(branchLocalMock).toHaveBeenCalledWith("/repo-two");
  });

  it("clears git metadata when the path is not a git repo", async () => {
    const projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push({
        path: "/plain-dir",
        collapsed: false,
        gitBranch: "stale-branch",
        gitDiffStats: { addedLines: 12, deletedLines: 4 },
      });
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
    expect(rawMock).not.toHaveBeenCalled();
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
        {
          path: "/repo-one",
          collapsed: false,
          gitBranch: "main",
          gitDiffStats: { addedLines: 0, deletedLines: 0 },
        },
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
        gitDiffStats: { addedLines: 0, deletedLines: 0 },
      },
    ]);

    repoOneBranch.resolve({ current: "main" });
    await refreshAllPromise;

    expect(projectsState.state).toEqual([
      {
        path: "/repo-one",
        collapsed: false,
        gitBranch: "main",
        gitDiffStats: { addedLines: 0, deletedLines: 0 },
      },
      {
        path: "/repo-two",
        collapsed: false,
        gitBranch: "feature/new-project",
        gitDiffStats: { addedLines: 0, deletedLines: 0 },
      },
    ]);
  });

  it("hydrates clean repos with zero diff stats", async () => {
    const projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push({
        path: "/repo-one",
        collapsed: false,
        gitBranch: "main",
      });
    });

    checkIsRepoMock.mockResolvedValue(true);
    branchLocalMock.mockResolvedValue({ current: "main" });

    const service = new ProjectGitService(projectsState, {
      refreshIntervalMs: 60_000,
    });
    await service.refreshProject("/repo-one");

    expect(projectsState.state).toEqual([
      {
        path: "/repo-one",
        collapsed: false,
        gitBranch: "main",
        gitDiffStats: { addedLines: 0, deletedLines: 0 },
      },
    ]);
  });

  it("counts untracked files in diff stats", async () => {
    const projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push({
        path: "/repo-one",
        collapsed: false,
        gitBranch: "main",
      });
    });

    checkIsRepoMock.mockResolvedValue(true);
    branchLocalMock.mockResolvedValue({ current: "main" });
    rawMock.mockImplementation(async (projectPath: string, args: string[]) => {
      if (projectPath !== "/repo-one") {
        return "";
      }
      if (args[0] === "rev-parse") {
        return "0123456789abcdef\n";
      }
      if (args[0] === "status" && args[1] === "--porcelain") {
        return "?? new-file.txt\n?? src/new-module.ts\n";
      }
      return "";
    });

    const service = new ProjectGitService(projectsState, {
      refreshIntervalMs: 60_000,
    });
    await service.refreshProject("/repo-one");

    expect(projectsState.state).toEqual([
      {
        path: "/repo-one",
        collapsed: false,
        gitBranch: "main",
        gitDiffStats: { addedLines: 2, deletedLines: 0 },
      },
    ]);
  });

  it("does not update state when git metadata is unchanged", async () => {
    const projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push({
        path: "/repo-one",
        collapsed: false,
        gitBranch: "main",
        gitDiffStats: { addedLines: 0, deletedLines: 0 },
      });
    });

    checkIsRepoMock.mockResolvedValue(true);
    branchLocalMock.mockResolvedValue({ current: "main" });

    const updateStateSpy = vi.spyOn(projectsState, "updateState");
    updateStateSpy.mockClear();

    const service = new ProjectGitService(projectsState, {
      refreshIntervalMs: 60_000,
    });
    await service.refreshAll();

    expect(updateStateSpy).not.toHaveBeenCalled();
  });

  it("falls back to the empty tree when HEAD does not exist yet", async () => {
    const projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push({ path: "/repo-one", collapsed: false });
    });

    checkIsRepoMock.mockResolvedValue(true);
    branchLocalMock.mockResolvedValue({ current: "main" });
    rawMock.mockImplementation(async (projectPath: string, args: string[]) => {
      if (projectPath !== "/repo-one") {
        return "";
      }
      if (args[0] === "rev-parse") {
        throw new Error("Needed a single revision");
      }
      if (
        args[0] === "diff" &&
        args[1] === "--numstat" &&
        args[3] === "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
      ) {
        return "3\t1\tsrc/index.ts\n";
      }
      return "";
    });

    const service = new ProjectGitService(projectsState, {
      refreshIntervalMs: 60_000,
    });
    await service.refreshProject("/repo-one");

    expect(projectsState.state).toEqual([
      {
        path: "/repo-one",
        collapsed: false,
        gitBranch: "main",
        gitDiffStats: { addedLines: 3, deletedLines: 1 },
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
    rawMock.mockImplementation(async (_projectPath: string, args: string[]) => {
      if (args[0] === "branch") {
        return "main\ndevelop\n";
      }
      if (args[0] === "rev-parse") {
        return "0123456789abcdef\n";
      }
      return "";
    });

    const service = new ProjectGitService(defineProjectState(), {
      refreshIntervalMs: 60_000,
    });
    const result = await service.getWorktreeCreationData("/repo-one");

    expect(result).toEqual({
      currentBranch: "main",
      localBranches: ["main", "develop"],
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
    rawMock.mockImplementation(async (_projectPath: string, args: string[]) => {
      if (args[0] === "branch") {
        return "develop\nmain\n";
      }
      if (args[0] === "rev-parse") {
        return "0123456789abcdef\n";
      }
      return "";
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

  it("falls back to alphabetical branch ordering when recency lookup fails", async () => {
    checkIsRepoMock.mockResolvedValue(true);
    branchLocalMock.mockResolvedValue({
      current: "main",
      branches: {
        main: {},
        develop: {},
      },
    });
    rawMock.mockImplementation(async (_projectPath: string, args: string[]) => {
      if (args[0] === "branch") {
        throw new Error("branch sort failed");
      }
      if (args[0] === "rev-parse") {
        return "0123456789abcdef\n";
      }
      return "";
    });

    const service = new ProjectGitService(defineProjectState(), {
      refreshIntervalMs: 60_000,
    });
    const result = await service.getWorktreeCreationData("/repo-one");

    expect(result.localBranches).toEqual(["develop", "main"]);
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
          fastMode: "fast",
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
          fastMode: "fast",
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
          fastMode: "fast",
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
          fastMode: "fast",
        },
        gitBranch: "feature/new-ui",
        gitDiffStats: { addedLines: 0, deletedLines: 0 },
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
      forceDeleteFolder: false,
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
      forceDeleteFolder: false,
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
        forceDeleteFolder: false,
      }),
    ).rejects.toThrow(
      "Deleting a worktree branch also requires deleting the folder.",
    );
  });

  it("returns a force-delete response for dirty worktrees", async () => {
    const projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push({
        path: "/repo-one-feature-new-ui",
        collapsed: false,
        gitBranch: "feature/new-ui",
        worktreeOriginPath: "/repo-one",
      });
    });

    rawMock.mockImplementationOnce(async () => {
      throw new Error(
        "fatal: '/repo-one-feature-new-ui' contains modified or untracked files, use --force to delete it",
      );
    });

    const service = new ProjectGitService(projectsState, {
      refreshIntervalMs: 60_000,
    });
    const result = await service.deleteWorktreeProject({
      path: "/repo-one-feature-new-ui",
      deleteFolder: true,
      deleteBranch: true,
      forceDeleteFolder: false,
    });

    expect(result).toEqual({
      requiresForce: true,
      errorMessage:
        "Project folder has modified or untracked files. Enable force delete to remove the worktree and discard those changes.",
    });
    expect(rawMock).toHaveBeenCalledTimes(1);
    expect(rawMock).toHaveBeenNthCalledWith(1, "/repo-one", [
      "worktree",
      "remove",
      "/repo-one-feature-new-ui",
    ]);
  });

  it("forces dirty worktree removal when requested", async () => {
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
      deleteBranch: false,
      forceDeleteFolder: true,
    });

    expect(result).toEqual({});
    expect(rawMock).toHaveBeenNthCalledWith(1, "/repo-one", [
      "worktree",
      "remove",
      "--force",
      "/repo-one-feature-new-ui",
    ]);
  });

  it("returns a warning when forced worktree branch deletion fails", async () => {
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
      forceDeleteFolder: true,
    });

    expect(result.warning).toContain(
      'deleting local branch "feature/new-ui" failed',
    );
    expect(result.warning).toContain("branch is not fully merged");
    expect(rawMock).toHaveBeenNthCalledWith(1, "/repo-one", [
      "worktree",
      "remove",
      "--force",
      "/repo-one-feature-new-ui",
    ]);
  });
});
