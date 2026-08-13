import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireProjectCommitLock,
  addTrackedProject,
  commitSelectedChangesWithGeneratedMessage,
  defineProjectState,
  pullProjectFromRemote,
  pushProjectToRemote,
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

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe("project-service pushProjectToRemote", () => {
  it("waits for a pending commit pipeline before pushing", async () => {
    const events: string[] = [];
    const pushToRemote = vi.fn(async () => {
      events.push("pushed");
    });

    const releaseCommitLock = await acquireProjectCommitLock("/repo");

    const pushPromise = pushProjectToRemote("/repo", {
      projectGitService: { pushToRemote },
    });

    await flushMicrotasks();
    expect(pushToRemote).not.toHaveBeenCalled();

    events.push("commit-released");
    releaseCommitLock();
    await pushPromise;

    expect(events).toEqual(["commit-released", "pushed"]);
    expect(pushToRemote).toHaveBeenCalledWith("/repo");
  });

  it("blocks a new commit pipeline while a push is in flight", async () => {
    const events: string[] = [];
    const pushDeferred = createDeferred<void>();
    const pushToRemote = vi.fn(() => pushDeferred.promise);

    const pushPromise = pushProjectToRemote("/repo", {
      projectGitService: { pushToRemote },
    });
    const commitLockPromise = acquireProjectCommitLock("/repo").then(
      (release) => {
        events.push("commit-acquired");
        return release;
      },
    );

    await flushMicrotasks();
    expect(pushToRemote).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);

    events.push("push-finished");
    pushDeferred.resolve();
    await pushPromise;

    const releaseCommitLock = await commitLockPromise;
    expect(events).toEqual(["push-finished", "commit-acquired"]);
    releaseCommitLock();
  });

  it("releases the commit lock when the push fails", async () => {
    const pushToRemote = vi.fn(async () => {
      throw new Error("push failed");
    });

    await expect(
      pushProjectToRemote("/repo", {
        projectGitService: { pushToRemote },
      }),
    ).rejects.toThrow("push failed");

    const releaseCommitLock = await acquireProjectCommitLock("/repo");
    releaseCommitLock();
  });

  it("does not wait on commit pipelines of other projects", async () => {
    const releaseOtherLock = await acquireProjectCommitLock("/repo-other");
    const pushToRemote = vi.fn().mockResolvedValue(undefined);

    await pushProjectToRemote("/repo", {
      projectGitService: { pushToRemote },
    });

    expect(pushToRemote).toHaveBeenCalledWith("/repo");
    releaseOtherLock();
  });
});

describe("project-service pullProjectFromRemote", () => {
  const pullResult = { upstreamBranch: "origin/main", pulledCommits: 2 };

  it("waits for a pending commit pipeline before pulling", async () => {
    const events: string[] = [];
    const pullFromRemote = vi.fn(async () => {
      events.push("pulled");
      return pullResult;
    });

    const releaseCommitLock = await acquireProjectCommitLock("/repo");

    const pullPromise = pullProjectFromRemote("/repo", {
      projectGitService: { pullFromRemote },
    });

    await flushMicrotasks();
    expect(pullFromRemote).not.toHaveBeenCalled();

    events.push("commit-released");
    releaseCommitLock();

    await expect(pullPromise).resolves.toEqual(pullResult);
    expect(events).toEqual(["commit-released", "pulled"]);
    expect(pullFromRemote).toHaveBeenCalledWith("/repo");
  });

  it("blocks a new commit pipeline while a pull is in flight", async () => {
    const events: string[] = [];
    const pullDeferred = createDeferred<typeof pullResult>();
    const pullFromRemote = vi.fn(() => pullDeferred.promise);

    const pullPromise = pullProjectFromRemote("/repo", {
      projectGitService: { pullFromRemote },
    });
    const commitLockPromise = acquireProjectCommitLock("/repo").then(
      (release) => {
        events.push("commit-acquired");
        return release;
      },
    );

    await flushMicrotasks();
    expect(pullFromRemote).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);

    events.push("pull-finished");
    pullDeferred.resolve(pullResult);
    await pullPromise;

    const releaseCommitLock = await commitLockPromise;
    expect(events).toEqual(["pull-finished", "commit-acquired"]);
    releaseCommitLock();
  });

  it("releases the commit lock when the pull fails", async () => {
    const pullFromRemote = vi.fn(async () => {
      throw new Error("pull failed");
    });

    await expect(
      pullProjectFromRemote("/repo", {
        projectGitService: { pullFromRemote },
      }),
    ).rejects.toThrow("pull failed");

    const releaseCommitLock = await acquireProjectCommitLock("/repo");
    releaseCommitLock();
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

describe("project-service commitSelectedChangesWithGeneratedMessage", () => {
  const titleGeneration = {
    provider: "cursor" as const,
    model: "composer-2.5",
  };

  async function collectStages(
    iterator: AsyncGenerator<{ stage: string }>,
  ): Promise<string[]> {
    const stages: string[] = [];
    for await (const event of iterator) {
      stages.push(event.stage);
    }
    return stages;
  }

  it("starts message generation before the git commit finishes", async () => {
    const commitStarted = createDeferred<void>();
    const commitFinished = createDeferred<void>();

    const generateCommitMessage = vi.fn(async () => ({
      subject: "Add auth tests",
    }));

    const projectGitService = {
      getSelectedChangesDiff: vi
        .fn()
        .mockResolvedValue("diff --git a/auth.ts b/auth.ts"),
      commitSelectedChanges: vi.fn(async () => {
        commitStarted.resolve();
        await commitFinished.promise;
      }),
      getLastCommitDiff: vi.fn(),
      amendLastCommitMessage: vi.fn().mockResolvedValue(undefined),
    };

    const iterator = commitSelectedChangesWithGeneratedMessage({
      path: "/repo",
      filePaths: ["auth.ts"],
      projectGitService,
      titleGeneration,
      generateCommitMessage,
    });

    const stagesPromise = collectStages(iterator);

    await commitStarted.promise;
    expect(generateCommitMessage).toHaveBeenCalledTimes(1);
    expect(generateCommitMessage).toHaveBeenCalledWith(
      titleGeneration,
      "diff --git a/auth.ts b/auth.ts",
    );
    expect(projectGitService.amendLastCommitMessage).not.toHaveBeenCalled();

    commitFinished.resolve();
    await expect(stagesPromise).resolves.toEqual([
      "generating",
      "committed",
      "done",
    ]);
    expect(projectGitService.getLastCommitDiff).not.toHaveBeenCalled();
    expect(projectGitService.amendLastCommitMessage).toHaveBeenCalledWith(
      "/repo",
      { subject: "Add auth tests", description: undefined },
    );
  });

  it("falls back to the last commit diff when the selected diff is empty", async () => {
    const generateCommitMessage = vi.fn(async () => ({
      subject: "Fix login",
      description: "Handle missing users.",
    }));

    const projectGitService = {
      getSelectedChangesDiff: vi.fn().mockResolvedValue(null),
      commitSelectedChanges: vi.fn().mockResolvedValue(undefined),
      getLastCommitDiff: vi
        .fn()
        .mockResolvedValue("diff --git a/login.ts b/login.ts"),
      amendLastCommitMessage: vi.fn().mockResolvedValue(undefined),
    };

    const stages = await collectStages(
      commitSelectedChangesWithGeneratedMessage({
        path: "/repo",
        filePaths: ["login.ts"],
        description: "Keep caller body.",
        projectGitService,
        titleGeneration,
        generateCommitMessage,
      }),
    );

    expect(stages).toEqual(["committed", "generating", "done"]);
    expect(generateCommitMessage).toHaveBeenCalledTimes(1);
    expect(generateCommitMessage).toHaveBeenCalledWith(
      titleGeneration,
      "diff --git a/login.ts b/login.ts",
    );
    expect(projectGitService.amendLastCommitMessage).toHaveBeenCalledWith(
      "/repo",
      { subject: "Fix login", description: "Keep caller body." },
    );
  });

  it("does not wait for generation when the git commit fails", async () => {
    const generateFinished = createDeferred<void>();
    const generateCommitMessage = vi.fn(async () => {
      await generateFinished.promise;
      return { subject: "Should not amend" };
    });

    const projectGitService = {
      getSelectedChangesDiff: vi
        .fn()
        .mockResolvedValue("diff --git a/a.ts b/a.ts"),
      commitSelectedChanges: vi
        .fn()
        .mockRejectedValue(new Error("index locked")),
      getLastCommitDiff: vi.fn(),
      amendLastCommitMessage: vi.fn(),
    };

    await expect(
      collectStages(
        commitSelectedChangesWithGeneratedMessage({
          path: "/repo",
          filePaths: ["a.ts"],
          projectGitService,
          titleGeneration,
          generateCommitMessage,
        }),
      ),
    ).rejects.toMatchObject({ message: "index locked" });

    expect(projectGitService.amendLastCommitMessage).not.toHaveBeenCalled();
    generateFinished.resolve();
    await generateFinished.promise;
  });
});
