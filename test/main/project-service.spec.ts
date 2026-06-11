import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireProjectCommitLock,
  addTrackedProject,
  defineProjectState,
  refreshTrackedProject,
} from "../../src/main/project-service";

const readProjectSettingsFileMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/main/project-settings-file", () => ({
  readProjectSettingsFile: readProjectSettingsFileMock,
  writeProjectSettingsFile: vi.fn(),
}));

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

describe("project-service addTrackedProject", () => {
  let tempDir: string;
  const refreshProject = vi.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "project-service-test-"));
    readProjectSettingsFileMock.mockReset();
    refreshProject.mockClear();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("hydrates worktree setup commands from .agent-ui settings when adding a project", async () => {
    const projectPath = path.join(tempDir, "repo-with-settings");
    readProjectSettingsFileMock.mockResolvedValue({
      worktreeSetupCommands: "pnpm install",
      localClaude: {
        defaultModel: "sonnet",
      },
    });

    const projectsState = defineProjectState();
    const context = {
      projectsState,
      projectGitService: {
        refreshProject,
      },
    };

    const result = await addTrackedProject(projectPath, context);

    expect(result).toEqual({ path: projectPath });
    expect(projectsState.state).toEqual([
      {
        path: projectPath,
        collapsed: false,
        worktreeSetupCommands: "pnpm install",
      },
    ]);
    expect(refreshProject).toHaveBeenCalledWith(projectPath);
  });

  it("adds a project without settings when no config file exists", async () => {
    const projectPath = path.join(tempDir, "plain-repo");
    readProjectSettingsFileMock.mockResolvedValue(null);

    const projectsState = defineProjectState();
    const context = {
      projectsState,
      projectGitService: {
        refreshProject,
      },
    };

    const result = await addTrackedProject(projectPath, context);

    expect(result).toEqual({ path: projectPath });
    expect(projectsState.state).toEqual([
      {
        path: projectPath,
        collapsed: false,
      },
    ]);
    expect(refreshProject).toHaveBeenCalledWith(projectPath);
  });

  it("does not duplicate a project when two adds overlap", async () => {
    const projectPath = path.join(tempDir, "race-repo");
    const deferredSettings = createDeferred<{
      worktreeSetupCommands?: string;
    } | null>();
    readProjectSettingsFileMock.mockReturnValue(deferredSettings.promise);

    const projectsState = defineProjectState();
    const context = {
      projectsState,
      projectGitService: {
        refreshProject,
      },
    };

    const firstAdd = addTrackedProject(projectPath, context);
    const secondAdd = addTrackedProject(projectPath, context);

    expect(projectsState.state).toEqual([
      {
        path: projectPath,
        collapsed: false,
      },
    ]);
    expect(readProjectSettingsFileMock).toHaveBeenCalledTimes(1);

    deferredSettings.resolve({
      worktreeSetupCommands: "pnpm install",
    });

    await expect(Promise.all([firstAdd, secondAdd])).resolves.toEqual([
      { path: projectPath },
      { path: projectPath },
    ]);

    expect(projectsState.state).toEqual([
      {
        path: projectPath,
        collapsed: false,
        worktreeSetupCommands: "pnpm install",
      },
    ]);
    expect(refreshProject).toHaveBeenCalledTimes(1);
  });
});

describe("project-service acquireProjectCommitLock", () => {
  it("blocks a second acquisition on the same project until released", async () => {
    const events: string[] = [];

    const releaseFirst = await acquireProjectCommitLock("/repo");
    const secondLock = acquireProjectCommitLock("/repo").then((release) => {
      events.push("second-acquired");
      return release;
    });

    await Promise.resolve();
    expect(events).toEqual([]);

    releaseFirst();
    const releaseSecond = await secondLock;
    expect(events).toEqual(["second-acquired"]);
    releaseSecond();
  });

  it("serializes three overlapping acquisitions in order", async () => {
    const order: number[] = [];

    const run = (id: number) =>
      acquireProjectCommitLock("/repo").then(async (release) => {
        order.push(id);
        await Promise.resolve();
        release();
      });

    await Promise.all([run(1), run(2), run(3)]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("does not block acquisitions for different projects", async () => {
    const releaseFirst = await acquireProjectCommitLock("/repo-one");
    const releaseSecond = await acquireProjectCommitLock("/repo-two");

    releaseFirst();
    releaseSecond();
  });

  it("releases waiters even when the holder releases after an error", async () => {
    const releaseFirst = await acquireProjectCommitLock("/repo");

    const second = acquireProjectCommitLock("/repo");

    try {
      throw new Error("commit failed");
    } catch {
      releaseFirst();
    }

    const releaseSecond = await second;
    releaseSecond();
  });
});

describe("project-service refreshTrackedProject", () => {
  it("forwards a normalized project path to the git service", async () => {
    const refreshProject = vi.fn().mockResolvedValue(undefined);
    const result = await refreshTrackedProject("  /repo-one  ", {
      projectGitService: {
        refreshProject,
      },
    });

    expect(result).toEqual({ path: "/repo-one" });
    expect(refreshProject).toHaveBeenCalledWith("/repo-one");
  });
});
