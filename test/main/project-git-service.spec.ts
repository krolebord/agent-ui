import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const simpleGitFactoryMock = vi.hoisted(() => vi.fn());
const checkIsRepoMock = vi.hoisted(() => vi.fn());
const branchLocalMock = vi.hoisted(() => vi.fn());
const rawMock = vi.hoisted(() => vi.fn());
const addMock = vi.hoisted(() => vi.fn());
const commitMock = vi.hoisted(() => vi.fn());
const pushMock = vi.hoisted(() => vi.fn());
const copyFileMock = vi.hoisted(() => vi.fn());
const mkdtempMock = vi.hoisted(() => vi.fn());
const readdirMock = vi.hoisted(() => vi.fn());
const rmMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn());
const writeProjectSettingsFileMock = vi.hoisted(() => vi.fn());

vi.mock("simple-git", () => ({
  default: simpleGitFactoryMock,
}));

vi.mock("node:fs/promises", () => ({
  copyFile: copyFileMock,
  mkdtemp: mkdtempMock,
  readdir: readdirMock,
  rm: rmMock,
  writeFile: writeFileMock,
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
    vi.useRealTimers();
    simpleGitFactoryMock.mockImplementation((projectPath: string) => {
      const envVars: Record<string, string> = {};
      const git = {
        checkIsRepo: () => checkIsRepoMock(projectPath),
        branchLocal: () => branchLocalMock(projectPath),
        add: (paths: string | string[]) => addMock(projectPath, paths),
        commit: (
          message: string | string[],
          paths?: string[],
          options?: Record<string, unknown>,
        ) => commitMock(projectPath, message, paths, options),
        push: (options?: string[]) => pushMock(projectPath, options),
        raw: (args: string[]) => {
          const envSnapshot = { ...envVars };
          if (Object.keys(envSnapshot).length === 0) {
            return rawMock(projectPath, args);
          }

          return rawMock(projectPath, args, envSnapshot);
        },
        env: (key: string, value: string) => {
          envVars[key] = value;
          return git;
        },
      };

      return git;
    });
    rawMock.mockImplementation(async (_projectPath: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        return "0123456789abcdef\n";
      }
      if (args[0] === "rev-parse" && args[1] === "--git-path") {
        return ".git/index\n";
      }
      if (args[0] === "rev-parse" && args.includes("@{upstream}")) {
        throw new Error("no upstream configured");
      }
      return "";
    });
    copyFileMock.mockResolvedValue(undefined);
    mkdtempMock.mockResolvedValue("/tmp/claude-ui-git-index-123");
    readdirMock.mockRejectedValue(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );
    rmMock.mockResolvedValue(undefined);
    writeFileMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
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

    const service = new ProjectGitService(projectsState);
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

    const service = new ProjectGitService(projectsState);
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

    const service = new ProjectGitService(projectsState);
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

    const service = new ProjectGitService(projectsState);

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

    const service = new ProjectGitService(projectsState);

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

  it("throttles refreshProject with leading and trailing edges", async () => {
    vi.useFakeTimers();

    const projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push({ path: "/repo-one", collapsed: false });
    });

    checkIsRepoMock.mockResolvedValue(true);
    branchLocalMock.mockResolvedValue({ current: "main" });

    const service = new ProjectGitService(projectsState);

    await service.refreshProject("/repo-one");
    expect(checkIsRepoMock).toHaveBeenCalledTimes(1);

    void service.refreshProject("/repo-one");
    void service.refreshProject("/repo-one");
    await vi.advanceTimersByTimeAsync(1_998);
    expect(checkIsRepoMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2);
    await vi.runAllTimersAsync();
    expect(checkIsRepoMock).toHaveBeenCalledTimes(2);

    await service.dispose();
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

    const service = new ProjectGitService(projectsState);
    await service.refreshProject("/repo-one");

    expect(projectsState.state).toEqual([
      {
        path: "/repo-one",
        collapsed: false,
        gitBranch: "main",
        gitDiffStats: { addedLines: 0, deletedLines: 0 },
      },
    ]);
    expect(projectsState.state[0]?.gitUpstreamDiffStats).toBeUndefined();
  });

  it("tracks commit divergence from the upstream branch", async () => {
    const projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push({
        path: "/repo-one",
        collapsed: false,
      });
    });

    checkIsRepoMock.mockResolvedValue(true);
    branchLocalMock.mockResolvedValue({ current: "main" });
    rawMock.mockImplementation(async (projectPath: string, args: string[]) => {
      if (projectPath !== "/repo-one") {
        return "";
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        return "0123456789abcdef\n";
      }
      if (args[0] === "rev-parse" && args.includes("@{upstream}")) {
        return "origin/main\n";
      }
      if (args[0] === "rev-list" && args[1] === "--left-right") {
        return "2\t5\n";
      }
      return "";
    });

    const service = new ProjectGitService(projectsState);
    await service.refreshProject("/repo-one");

    expect(projectsState.state).toEqual([
      {
        path: "/repo-one",
        collapsed: false,
        gitBranch: "main",
        gitDiffStats: { addedLines: 0, deletedLines: 0 },
        gitUpstreamDiffStats: {
          upstreamBranch: "origin/main",
          aheadCommits: 5,
          behindCommits: 2,
        },
      },
    ]);
  });

  it("counts untracked files in diff stats without mutating the real index", async () => {
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
    rawMock.mockImplementation(
      async (
        projectPath: string,
        args: string[],
        env?: Record<string, string>,
      ) => {
        if (projectPath !== "/repo-one") {
          return "";
        }
        if (args[0] === "rev-parse" && args[1] === "--verify") {
          return "0123456789abcdef\n";
        }
        if (args[0] === "rev-parse" && args[1] === "--git-path") {
          return ".git/index\n";
        }
        if (
          args[0] === "diff" &&
          args[1] === "--cached" &&
          args[2] === "--numstat" &&
          env?.GIT_INDEX_FILE === "/tmp/claude-ui-git-index-123/index"
        ) {
          return "1\t0\tnew-file.txt\n1\t0\tsrc/new-module.ts\n";
        }
        return "";
      },
    );

    const service = new ProjectGitService(projectsState);
    await service.refreshProject("/repo-one");

    expect(projectsState.state).toEqual([
      {
        path: "/repo-one",
        collapsed: false,
        gitBranch: "main",
        gitDiffStats: { addedLines: 2, deletedLines: 0 },
      },
    ]);
    expect(copyFileMock).toHaveBeenCalledWith(
      "/repo-one/.git/index",
      "/tmp/claude-ui-git-index-123/index",
    );
    expect(rawMock).toHaveBeenCalledWith("/repo-one", ["add", "-A"], {
      GIT_INDEX_FILE: "/tmp/claude-ui-git-index-123/index",
    });
    expect(rawMock).not.toHaveBeenCalledWith("/repo-one", ["add", "-A"], {});
    expect(rmMock).toHaveBeenCalledWith("/tmp/claude-ui-git-index-123", {
      recursive: true,
      force: true,
    });
  });

  it("stages paths before committing selected changes", async () => {
    checkIsRepoMock.mockResolvedValue(true);
    branchLocalMock.mockResolvedValue({ current: "main", branches: {} });
    addMock.mockResolvedValue(undefined);
    commitMock.mockResolvedValue(undefined);

    const projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push({ path: "/repo-one", collapsed: false });
    });

    const service = new ProjectGitService(projectsState);
    await service.commitSelectedChanges("/repo-one", {
      paths: [
        "src/hooks/use-copy-to-clipboard.ts",
        "src/components/diff-review-pane.tsx",
      ],
      subject: "Add copy hook",
      description: "Extract clipboard helper.",
    });

    expect(addMock).toHaveBeenCalledWith("/repo-one", [
      "src/hooks/use-copy-to-clipboard.ts",
      "src/components/diff-review-pane.tsx",
    ]);
    expect(commitMock).toHaveBeenCalledWith(
      "/repo-one",
      ["Add copy hook", "Extract clipboard helper."],
      [
        "src/hooks/use-copy-to-clipboard.ts",
        "src/components/diff-review-pane.tsx",
      ],
      undefined,
    );
  });

  it("reads the latest commit diff for selected paths", async () => {
    checkIsRepoMock.mockResolvedValue(true);
    rawMock.mockImplementation(async (_projectPath: string, args: string[]) => {
      if (args[0] === "show") {
        return "diff --git a/file.ts b/file.ts\n";
      }
      return "";
    });

    const service = new ProjectGitService(defineProjectState());
    const diff = await service.getLastCommitDiff("/repo-one", ["file.ts"]);

    expect(diff).toBe("diff --git a/file.ts b/file.ts");
    expect(rawMock).toHaveBeenCalledWith("/repo-one", [
      "show",
      "--pretty=format:",
      "--no-color",
      "HEAD",
      "--",
      "file.ts",
    ]);
  });

  it("amends the latest commit message", async () => {
    checkIsRepoMock.mockResolvedValue(true);
    branchLocalMock.mockResolvedValue({ current: "main", branches: {} });
    commitMock.mockResolvedValue(undefined);

    const projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push({ path: "/repo-one", collapsed: false });
    });

    const service = new ProjectGitService(projectsState);
    await service.amendLastCommitMessage("/repo-one", {
      subject: "Final subject",
      description: "Final body.",
    });

    expect(commitMock).toHaveBeenCalledWith(
      "/repo-one",
      ["Final subject", "Final body."],
      [],
      { "--amend": null },
    );
  });

  it("discards a staged new file by resetting it and deleting it", async () => {
    checkIsRepoMock.mockResolvedValue(true);
    branchLocalMock.mockResolvedValue({ current: "main", branches: {} });
    rawMock.mockImplementation(async (_projectPath: string, args: string[]) => {
      if (args[0] === "ls-tree") {
        return "";
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        return "0123456789abcdef\n";
      }
      if (args[0] === "rev-parse" && args[1] === "--git-path") {
        return ".git/index\n";
      }
      return "";
    });

    const service = new ProjectGitService(defineProjectState());
    await service.discardChanges("/repo-one", ["new-file.ts"]);

    expect(rawMock).toHaveBeenCalledWith("/repo-one", [
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      "HEAD",
      "--",
      "new-file.ts",
    ]);
    expect(rawMock).toHaveBeenCalledWith("/repo-one", [
      "reset",
      "-q",
      "HEAD",
      "--",
      "new-file.ts",
    ]);
    expect(rawMock).not.toHaveBeenCalledWith("/repo-one", [
      "checkout",
      "HEAD",
      "--",
      "new-file.ts",
    ]);
    expect(rmMock).toHaveBeenCalledWith("/repo-one/new-file.ts", {
      force: true,
      recursive: true,
    });
  });

  it("discards a staged rename by restoring the old path and deleting the new path", async () => {
    checkIsRepoMock.mockResolvedValue(true);
    branchLocalMock.mockResolvedValue({ current: "main", branches: {} });
    rawMock.mockImplementation(async (_projectPath: string, args: string[]) => {
      if (args[0] === "ls-tree") {
        return "old-file.ts\0";
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        return "0123456789abcdef\n";
      }
      if (args[0] === "rev-parse" && args[1] === "--git-path") {
        return ".git/index\n";
      }
      return "";
    });

    const service = new ProjectGitService(defineProjectState());
    await service.discardChanges("/repo-one", ["old-file.ts", "new-file.ts"]);

    expect(rawMock).toHaveBeenCalledWith("/repo-one", [
      "reset",
      "-q",
      "HEAD",
      "--",
      "old-file.ts",
      "new-file.ts",
    ]);
    expect(rawMock).toHaveBeenCalledWith("/repo-one", [
      "checkout",
      "HEAD",
      "--",
      "old-file.ts",
    ]);
    expect(rmMock).toHaveBeenCalledWith("/repo-one/new-file.ts", {
      force: true,
      recursive: true,
    });
  });

  it("discards a new file before the first commit", async () => {
    checkIsRepoMock.mockResolvedValue(true);
    branchLocalMock.mockResolvedValue({ current: "main", branches: {} });
    rawMock.mockImplementation(async (_projectPath: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        throw new Error("Needed a single revision");
      }
      if (args[0] === "ls-tree") {
        return "";
      }
      if (args[0] === "rev-parse" && args[1] === "--git-path") {
        return ".git/index\n";
      }
      return "";
    });

    const service = new ProjectGitService(defineProjectState());
    await service.discardChanges("/repo-one", ["new-file.ts"]);

    expect(rawMock).toHaveBeenCalledWith("/repo-one", [
      "reset",
      "-q",
      "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      "--",
      "new-file.ts",
    ]);
    expect(rmMock).toHaveBeenCalledWith("/repo-one/new-file.ts", {
      force: true,
      recursive: true,
    });
  });

  it("returns the uncommitted diff using a temporary index", async () => {
    checkIsRepoMock.mockResolvedValue(true);
    rawMock.mockImplementation(
      async (
        projectPath: string,
        args: string[],
        env?: Record<string, string>,
      ) => {
        if (projectPath !== "/repo-one") {
          return "";
        }
        if (args[0] === "rev-parse" && args[1] === "--verify") {
          return "0123456789abcdef\n";
        }
        if (args[0] === "rev-parse" && args[1] === "--git-path") {
          return ".git/index\n";
        }
        if (
          args[0] === "diff" &&
          args[1] === "--cached" &&
          env?.GIT_INDEX_FILE === "/tmp/claude-ui-git-index-123/index"
        ) {
          return "diff --git a/file.txt b/file.txt\n";
        }
        return "";
      },
    );

    const service = new ProjectGitService(defineProjectState());
    const diff = await service.getUncommittedDiff("/repo-one");

    expect(diff).toBe("diff --git a/file.txt b/file.txt");
    expect(rawMock).toHaveBeenCalledWith("/repo-one", ["add", "-A"], {
      GIT_INDEX_FILE: "/tmp/claude-ui-git-index-123/index",
    });
    expect(rawMock).not.toHaveBeenCalledWith("/repo-one", ["add", "-A"], {});
  });

  it("caches the git index path across temporary-index operations", async () => {
    checkIsRepoMock.mockResolvedValue(true);
    rawMock.mockImplementation(
      async (
        projectPath: string,
        args: string[],
        env?: Record<string, string>,
      ) => {
        if (projectPath !== "/repo-cache") {
          return "";
        }
        if (args[0] === "rev-parse" && args[1] === "--verify") {
          return "0123456789abcdef\n";
        }
        if (args[0] === "rev-parse" && args[1] === "--git-path") {
          return ".git/index\n";
        }
        if (
          args[0] === "diff" &&
          args[1] === "--cached" &&
          env?.GIT_INDEX_FILE === "/tmp/claude-ui-git-index-123/index"
        ) {
          return "diff --git a/file.txt b/file.txt\n";
        }
        return "";
      },
    );

    const service = new ProjectGitService(defineProjectState());

    expect(await service.getUncommittedDiff("/repo-cache")).toBe(
      "diff --git a/file.txt b/file.txt",
    );
    expect(await service.getUncommittedDiff("/repo-cache")).toBe(
      "diff --git a/file.txt b/file.txt",
    );

    const gitIndexLookups = rawMock.mock.calls.filter(
      ([projectPath, args]) =>
        projectPath === "/repo-cache" &&
        Array.isArray(args) &&
        args[0] === "rev-parse" &&
        args[1] === "--git-path",
    );

    expect(gitIndexLookups).toHaveLength(1);
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

    const service = new ProjectGitService(projectsState);
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
    rawMock.mockImplementation(
      async (
        projectPath: string,
        args: string[],
        env?: Record<string, string>,
      ) => {
        if (projectPath !== "/repo-one") {
          return "";
        }
        if (args[0] === "rev-parse" && args[1] === "--verify") {
          throw new Error("Needed a single revision");
        }
        if (args[0] === "rev-parse" && args[1] === "--git-path") {
          return ".git/index\n";
        }
        if (
          args[0] === "diff" &&
          args[1] === "--cached" &&
          args[2] === "--numstat" &&
          args[4] === "4b825dc642cb6eb9a060e54bf8d69288fbee4904" &&
          env?.GIT_INDEX_FILE === "/tmp/claude-ui-git-index-123/index"
        ) {
          return "3\t1\tsrc/index.ts\n";
        }
        return "";
      },
    );

    const service = new ProjectGitService(projectsState);
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

    const service = new ProjectGitService(defineProjectState());
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

    const service = new ProjectGitService(defineProjectState());
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

    const service = new ProjectGitService(defineProjectState());
    const result = await service.getWorktreeCreationData("/repo-one");

    expect(result.localBranches).toEqual(["develop", "main"]);
  });

  it("rejects worktree creation data when source is itself a worktree", async () => {
    const projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push({
        path: "/repo-one-feature",
        collapsed: false,
        gitBranch: "feature",
        worktreeOriginPath: "/repo-one",
      });
    });

    const service = new ProjectGitService(projectsState);

    await expect(
      service.getWorktreeCreationData("/repo-one-feature"),
    ).rejects.toThrow(
      "Cannot create a worktree from a project that is itself a worktree.",
    );
  });

  it("rejects worktree project creation when source is itself a worktree", async () => {
    const projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push({
        path: "/repo-one-feature",
        collapsed: false,
        gitBranch: "feature",
        worktreeOriginPath: "/repo-one",
      });
    });

    checkIsRepoMock.mockResolvedValue(true);
    branchLocalMock.mockResolvedValue({
      current: "feature",
      branches: { feature: {}, main: {} },
    });

    const service = new ProjectGitService(projectsState);

    await expect(
      service.createWorktreeProject({
        sourcePath: "/repo-one-feature",
        fromBranch: "feature",
        newBranch: "feature/nested",
        destinationPath: "/repo-one-feature-nested",
      }),
    ).rejects.toThrow(
      "Cannot create a worktree from a project that is itself a worktree.",
    );

    expect(rawMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(["worktree", "add"]),
    );
  });

  it("creates a worktree project with alias and origin metadata", async () => {
    const projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push({
        path: "/repo-one",
        collapsed: false,
        gitBranch: "main",
        worktreeSetupCommands: "pnpm install",
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

    const service = new ProjectGitService(projectsState);
    const result = await service.createWorktreeProject({
      sourcePath: "/repo-one",
      fromBranch: "main",
      newBranch: "feature/new-ui",
      destinationPath: "/repo-one-feature-new-ui",
      alias: "UI Worktree",
    });

    expect(result).toEqual({
      path: "/repo-one-feature-new-ui",
      projectRoot: "/repo-one",
      worktreeRoot: "/repo-one-feature-new-ui",
      setupCommands: ["pnpm install"],
    });
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
        worktreeSetupCommands: "pnpm install",
      },
    );
    expect(projectsState.state).toEqual([
      {
        path: "/repo-one",
        collapsed: false,
        gitBranch: "main",
        worktreeSetupCommands: "pnpm install",
      },
      {
        path: "/repo-one-feature-new-ui",
        collapsed: false,
        alias: "UI Worktree",
        worktreeOriginPath: "/repo-one",
        worktreeSetupCommands: "pnpm install",
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

    const service = new ProjectGitService(defineProjectState());

    const result = await service.createWorktreeProject({
      sourcePath: "/repo-one",
      fromBranch: "main",
      newBranch: "feature/new-ui",
      destinationPath: "/repo-one-feature-new-ui",
    });
    expect(result.path).toBe("/repo-one-feature-new-ui");
    expect(result.setupCommands).toEqual([]);

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

    const service = new ProjectGitService(defineProjectState());

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

    const service = new ProjectGitService(projectsState);
    const result = await service.deleteWorktreeProject({
      path: "/repo-one-feature-new-ui",
      deleteFolder: true,
      deleteBranch: true,
      forceDeleteFolder: false,
    });

    expect(result).toEqual({});
    expect(rawMock).toHaveBeenNthCalledWith(1, "/repo-one-feature-new-ui", [
      "status",
      "--porcelain",
    ]);
    expect(rawMock).toHaveBeenNthCalledWith(2, "/repo-one", [
      "worktree",
      "remove",
      "/repo-one-feature-new-ui",
    ]);
    expect(rawMock).toHaveBeenNthCalledWith(3, "/repo-one", [
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
    rawMock.mockImplementationOnce(async () => "");
    rawMock.mockImplementationOnce(async () => {
      throw new Error("branch is not fully merged");
    });

    const service = new ProjectGitService(projectsState);
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

    const service = new ProjectGitService(projectsState);

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

    rawMock.mockImplementationOnce(
      async (_projectPath: string, args: string[]) => {
        if (args[0] === "status" && args[1] === "--porcelain") {
          return " M dirty\n";
        }
        return "";
      },
    );

    const service = new ProjectGitService(projectsState);
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
    expect(rawMock).toHaveBeenNthCalledWith(1, "/repo-one-feature-new-ui", [
      "status",
      "--porcelain",
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

    const service = new ProjectGitService(projectsState);
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

    const service = new ProjectGitService(projectsState);
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

  it("returns parsed setup commands in the result without running them", async () => {
    const projectsState = defineProjectState();
    projectsState.updateState((projects) => {
      projects.push({
        path: "/repo-one",
        collapsed: false,
        gitBranch: "main",
        worktreeSetupCommands: "pnpm install\n\n  \npnpm build",
      });
    });

    checkIsRepoMock.mockResolvedValue(true);
    branchLocalMock.mockImplementation(async (projectPath: string) => {
      if (projectPath === "/repo-one") {
        return { current: "main", branches: { main: {} } };
      }
      return { current: null, branches: {} };
    });

    const service = new ProjectGitService(projectsState);
    const result = await service.createWorktreeProject({
      sourcePath: "/repo-one",
      fromBranch: "main",
      newBranch: "feature/blank-lines",
      destinationPath: "/repo-one-blank-lines",
    });

    expect(result.setupCommands).toEqual(["pnpm install", "pnpm build"]);
    expect(
      projectsState.state.some((p) => p.path === "/repo-one-blank-lines"),
    ).toBe(true);
  });

  describe("getCommitHistory", () => {
    const FIELD = "\x1f";
    const RECORD = "\x1e";
    const GIT_LOG_FORMAT =
      "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1f%b%x1e";

    const hashA = "a".repeat(40);
    const hashB = "b".repeat(40);
    const hashC = "c".repeat(40);

    function logRecord(input: {
      hash: string;
      parents?: string;
      authorName?: string;
      authorEmail?: string;
      authorDate?: string;
      refs?: string;
      subject?: string;
      body?: string;
    }): string {
      return (
        [
          input.hash,
          input.parents ?? "",
          input.authorName ?? "krolebord",
          input.authorEmail ?? "krolebord@example.com",
          input.authorDate ?? "2026-06-10T12:00:00+00:00",
          input.refs ?? "",
          input.subject ?? "Commit subject",
          input.body ?? "",
        ].join(FIELD) + RECORD
      );
    }

    it("returns an empty page when the path is not a git repo", async () => {
      checkIsRepoMock.mockResolvedValue(false);

      const service = new ProjectGitService(defineProjectState());
      const page = await service.getCommitHistory("/plain-dir", { limit: 30 });

      expect(page).toEqual({ commits: [], nextCursor: null });
      expect(rawMock).not.toHaveBeenCalled();
    });

    it("returns an empty page when the repo has no commits yet", async () => {
      checkIsRepoMock.mockResolvedValue(true);
      rawMock.mockImplementation(
        async (_projectPath: string, args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "--verify") {
            throw new Error("Needed a single revision");
          }
          return "";
        },
      );

      const service = new ProjectGitService(defineProjectState());
      const page = await service.getCommitHistory("/repo-one", { limit: 30 });

      expect(page).toEqual({ commits: [], nextCursor: null });
      expect(rawMock).not.toHaveBeenCalledWith(
        "/repo-one",
        expect.arrayContaining(["log"]),
      );
    });

    it("returns parsed commits and a cursor when more history is available", async () => {
      checkIsRepoMock.mockResolvedValue(true);
      rawMock.mockImplementation(
        async (_projectPath: string, args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "--verify") {
            return `${hashA}\n`;
          }
          if (args[0] === "log") {
            return [
              logRecord({
                hash: hashA,
                parents: hashB,
                refs: "HEAD -> main, tag: v1.2.3, origin/main",
                subject: "Latest commit",
                body: "First line.\n\nSecond line.",
              }),
              logRecord({
                hash: hashB,
                parents: hashC,
                subject: "Middle commit",
              }),
              logRecord({ hash: hashC, subject: "Extra commit" }),
            ].join("\n");
          }
          return "";
        },
      );

      const service = new ProjectGitService(defineProjectState());
      const page = await service.getCommitHistory("/repo-one", { limit: 2 });

      expect(rawMock).toHaveBeenCalledWith("/repo-one", [
        "log",
        `--format=${GIT_LOG_FORMAT}`,
        "--max-count=3",
        "HEAD",
      ]);
      expect(page.commits).toEqual([
        {
          hash: hashA,
          parentHashes: [hashB],
          authorName: "krolebord",
          authorEmail: "krolebord@example.com",
          authorDate: "2026-06-10T12:00:00+00:00",
          refs: ["HEAD -> main", "tag: v1.2.3", "origin/main"],
          subject: "Latest commit",
          body: "First line.\n\nSecond line.",
          unpushed: false,
        },
        {
          hash: hashB,
          parentHashes: [hashC],
          authorName: "krolebord",
          authorEmail: "krolebord@example.com",
          authorDate: "2026-06-10T12:00:00+00:00",
          refs: [],
          subject: "Middle commit",
          body: "",
          unpushed: false,
        },
      ]);
      expect(page.nextCursor).toBe(hashB);
    });

    it("returns no cursor when the history fits within the limit", async () => {
      checkIsRepoMock.mockResolvedValue(true);
      rawMock.mockImplementation(
        async (_projectPath: string, args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "--verify") {
            return `${hashA}\n`;
          }
          if (args[0] === "log") {
            return logRecord({ hash: hashA, subject: "Only commit" });
          }
          return "";
        },
      );

      const service = new ProjectGitService(defineProjectState());
      const page = await service.getCommitHistory("/repo-one", { limit: 30 });

      expect(page.commits).toHaveLength(1);
      expect(page.commits[0]?.parentHashes).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });

    it("continues from a cursor and skips the cursor commit itself", async () => {
      checkIsRepoMock.mockResolvedValue(true);
      rawMock.mockImplementation(
        async (_projectPath: string, args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "--verify") {
            return `${hashA}\n`;
          }
          if (args[0] === "log") {
            return logRecord({ hash: hashC, subject: "Older commit" });
          }
          return "";
        },
      );

      const service = new ProjectGitService(defineProjectState());
      const page = await service.getCommitHistory("/repo-one", {
        cursor: hashB,
        limit: 30,
      });

      expect(rawMock).toHaveBeenCalledWith("/repo-one", [
        "log",
        `--format=${GIT_LOG_FORMAT}`,
        "--max-count=31",
        "--skip=1",
        hashB,
      ]);
      expect(page.commits.map((commit) => commit.hash)).toEqual([hashC]);
      expect(page.nextCursor).toBeNull();
    });

    it("marks commits ahead of the upstream as unpushed", async () => {
      checkIsRepoMock.mockResolvedValue(true);
      rawMock.mockImplementation(
        async (_projectPath: string, args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "--verify") {
            return `${hashA}\n`;
          }
          if (args[0] === "rev-list" && args[1] === "@{upstream}..HEAD") {
            return `${hashA}\n`;
          }
          if (args[0] === "log") {
            return [
              logRecord({ hash: hashA, subject: "Local only" }),
              logRecord({ hash: hashB, subject: "Already pushed" }),
            ].join("\n");
          }
          return "";
        },
      );

      const service = new ProjectGitService(defineProjectState());
      const page = await service.getCommitHistory("/repo-one", { limit: 30 });

      expect(rawMock).toHaveBeenCalledWith("/repo-one", [
        "rev-list",
        "@{upstream}..HEAD",
      ]);
      expect(
        page.commits.map(({ hash, unpushed }) => ({ hash, unpushed })),
      ).toEqual([
        { hash: hashA, unpushed: true },
        { hash: hashB, unpushed: false },
      ]);
    });

    it("treats all commits as pushed when no upstream is configured", async () => {
      checkIsRepoMock.mockResolvedValue(true);
      rawMock.mockImplementation(
        async (_projectPath: string, args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "--verify") {
            return `${hashA}\n`;
          }
          if (args[0] === "rev-list" && args[1] === "@{upstream}..HEAD") {
            throw new Error("no upstream configured");
          }
          if (args[0] === "log") {
            return logRecord({ hash: hashA, subject: "Local commit" });
          }
          return "";
        },
      );

      const service = new ProjectGitService(defineProjectState());
      const page = await service.getCommitHistory("/repo-one", { limit: 30 });

      expect(page.commits.map((commit) => commit.unpushed)).toEqual([false]);
    });

    it("rejects an invalid cursor", async () => {
      checkIsRepoMock.mockResolvedValue(true);

      const service = new ProjectGitService(defineProjectState());

      await expect(
        service.getCommitHistory("/repo-one", {
          cursor: "not-a-hash; rm -rf /",
          limit: 30,
        }),
      ).rejects.toThrow("Invalid commit hash.");
      expect(rawMock).not.toHaveBeenCalledWith(
        "/repo-one",
        expect.arrayContaining(["log"]),
      );
    });
  });

  describe("pushToRemote", () => {
    it("pushes to the configured upstream", async () => {
      checkIsRepoMock.mockResolvedValue(true);
      branchLocalMock.mockResolvedValue({ current: "main" });
      pushMock.mockResolvedValue(undefined);
      rawMock.mockImplementation(
        async (_projectPath: string, args: string[]) => {
          if (args[0] === "symbolic-ref" && args[1] === "--short") {
            return "main\n";
          }
          if (args[0] === "rev-parse" && args.includes("@{upstream}")) {
            return "origin/main\n";
          }
          if (args[0] === "rev-parse" && args[1] === "--verify") {
            return "0123456789abcdef\n";
          }
          if (args[0] === "rev-parse" && args[1] === "--git-path") {
            return ".git/index\n";
          }
          return "";
        },
      );

      const service = new ProjectGitService(defineProjectState());
      await service.pushToRemote("/repo-one");

      expect(pushMock).toHaveBeenCalledWith("/repo-one", undefined);
    });

    it("publishes the branch when no upstream is configured", async () => {
      checkIsRepoMock.mockResolvedValue(true);
      branchLocalMock.mockResolvedValue({ current: "feature/new-ui" });
      pushMock.mockResolvedValue(undefined);
      rawMock.mockImplementation(
        async (_projectPath: string, args: string[]) => {
          if (args[0] === "symbolic-ref" && args[1] === "--short") {
            return "feature/new-ui\n";
          }
          if (args[0] === "rev-parse" && args.includes("@{upstream}")) {
            throw new Error("no upstream configured");
          }
          if (args[0] === "rev-parse" && args[1] === "--verify") {
            return "0123456789abcdef\n";
          }
          if (args[0] === "rev-parse" && args[1] === "--git-path") {
            return ".git/index\n";
          }
          return "";
        },
      );

      const service = new ProjectGitService(defineProjectState());
      await service.pushToRemote("/repo-one");

      expect(pushMock).toHaveBeenCalledWith("/repo-one", [
        "--set-upstream",
        "origin",
        "feature/new-ui",
      ]);
    });

    it("rejects pushing from a detached HEAD", async () => {
      checkIsRepoMock.mockResolvedValue(true);
      rawMock.mockImplementation(
        async (_projectPath: string, args: string[]) => {
          if (args[0] === "symbolic-ref") {
            throw new Error("ref HEAD is not a symbolic ref");
          }
          return "";
        },
      );

      const service = new ProjectGitService(defineProjectState());

      await expect(service.pushToRemote("/repo-one")).rejects.toThrow(
        "Cannot push from a detached HEAD.",
      );
      expect(pushMock).not.toHaveBeenCalled();
    });

    it("surfaces push failures", async () => {
      checkIsRepoMock.mockResolvedValue(true);
      pushMock.mockRejectedValue(new Error("remote: permission denied"));
      rawMock.mockImplementation(
        async (_projectPath: string, args: string[]) => {
          if (args[0] === "symbolic-ref" && args[1] === "--short") {
            return "main\n";
          }
          if (args[0] === "rev-parse" && args.includes("@{upstream}")) {
            return "origin/main\n";
          }
          return "";
        },
      );

      const service = new ProjectGitService(defineProjectState());

      await expect(service.pushToRemote("/repo-one")).rejects.toThrow(
        "remote: permission denied",
      );
    });

    it("throws when the project is not a git repository", async () => {
      checkIsRepoMock.mockResolvedValue(false);

      const service = new ProjectGitService(defineProjectState());

      await expect(service.pushToRemote("/plain-dir")).rejects.toThrow(
        "Project is not a Git repository.",
      );
      expect(pushMock).not.toHaveBeenCalled();
    });
  });

  describe("getCommitDiff", () => {
    const commitHash = "d".repeat(40);
    const parentHash = "e".repeat(40);

    it("diffs a commit against its first parent", async () => {
      checkIsRepoMock.mockResolvedValue(true);
      rawMock.mockImplementation(
        async (_projectPath: string, args: string[]) => {
          if (
            args[0] === "rev-parse" &&
            args[1] === "--verify" &&
            args[2] === `${commitHash}^`
          ) {
            return `${parentHash}\n`;
          }
          if (args[0] === "diff") {
            return "diff --git a/file.ts b/file.ts\n";
          }
          return "";
        },
      );

      const service = new ProjectGitService(defineProjectState());
      const diff = await service.getCommitDiff("/repo-one", commitHash);

      expect(diff).toBe("diff --git a/file.ts b/file.ts");
      expect(rawMock).toHaveBeenCalledWith("/repo-one", [
        "diff",
        "--no-color",
        parentHash,
        commitHash,
      ]);
    });

    it("falls back to the empty tree for root commits", async () => {
      checkIsRepoMock.mockResolvedValue(true);
      rawMock.mockImplementation(
        async (_projectPath: string, args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "--verify") {
            throw new Error("Needed a single revision");
          }
          if (args[0] === "diff") {
            return "diff --git a/file.ts b/file.ts\n";
          }
          return "";
        },
      );

      const service = new ProjectGitService(defineProjectState());
      const diff = await service.getCommitDiff("/repo-one", commitHash);

      expect(diff).toBe("diff --git a/file.ts b/file.ts");
      expect(rawMock).toHaveBeenCalledWith("/repo-one", [
        "diff",
        "--no-color",
        "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        commitHash,
      ]);
    });

    it("returns null when the commit has no changes", async () => {
      checkIsRepoMock.mockResolvedValue(true);
      rawMock.mockImplementation(
        async (_projectPath: string, args: string[]) => {
          if (args[0] === "rev-parse" && args[1] === "--verify") {
            return `${parentHash}\n`;
          }
          return "";
        },
      );

      const service = new ProjectGitService(defineProjectState());
      const diff = await service.getCommitDiff("/repo-one", commitHash);

      expect(diff).toBeNull();
    });

    it("rejects invalid commit hashes", async () => {
      checkIsRepoMock.mockResolvedValue(true);

      const service = new ProjectGitService(defineProjectState());

      await expect(
        service.getCommitDiff("/repo-one", "HEAD; rm -rf /"),
      ).rejects.toThrow("Invalid commit hash.");
      expect(rawMock).not.toHaveBeenCalledWith(
        "/repo-one",
        expect.arrayContaining(["diff"]),
      );
    });

    it("throws when the project is not a git repository", async () => {
      checkIsRepoMock.mockResolvedValue(false);

      const service = new ProjectGitService(defineProjectState());

      await expect(
        service.getCommitDiff("/plain-dir", commitHash),
      ).rejects.toThrow("Project is not a Git repository.");
    });
  });
});
