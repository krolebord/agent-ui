import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createConversationLinker,
  type GitDirInfo,
  inspectGitDir,
} from "../../../src/main/session-memory/linking";
import type { Session } from "../../../src/main/sessions/state";

function fakeInspector(entries: Record<string, GitDirInfo>) {
  return async (dir: string): Promise<GitDirInfo> =>
    entries[dir] ?? { kind: "none" };
}

const projects = [
  { path: "/home/u/projects/app" },
  { path: "/home/u/projects/app-sales" },
  {
    path: "/home/u/projects/app-feature-x",
    worktreeOriginPath: "/home/u/projects/app",
  },
];

describe("createConversationLinker project resolution", () => {
  it("maps cwds inside a project, preferring the most specific project", async () => {
    const linker = createConversationLinker({
      projects,
      sessions: {},
      inspectGitDir: fakeInspector({}),
    });

    await expect(
      linker.resolveProjectPath("/home/u/projects/app/web"),
    ).resolves.toBe("/home/u/projects/app");
    await expect(
      linker.resolveProjectPath("/home/u/projects/app-sales"),
    ).resolves.toBe("/home/u/projects/app-sales");
    await expect(linker.resolveProjectPath(null)).resolves.toBeNull();
  });

  it("maps registered worktree projects to their origin project", async () => {
    const linker = createConversationLinker({
      projects,
      sessions: {},
      inspectGitDir: fakeInspector({}),
    });

    await expect(
      linker.resolveProjectPath("/home/u/projects/app-feature-x/src"),
    ).resolves.toBe("/home/u/projects/app");
  });

  it("follows unregistered git worktrees to their origin repository", async () => {
    const linker = createConversationLinker({
      projects,
      sessions: {},
      inspectGitDir: fakeInspector({
        "/home/u/.codex/worktrees/1234/app": {
          kind: "worktree",
          originPath: "/home/u/projects/app",
        },
      }),
    });

    await expect(
      linker.resolveProjectPath("/home/u/.codex/worktrees/1234/app/pkg"),
    ).resolves.toBe("/home/u/projects/app");
  });

  it("maps deleted sibling worktree directories to the project they were named after", async () => {
    const linker = createConversationLinker({
      projects,
      sessions: {},
      inspectGitDir: fakeInspector({
        "/home/u/projects/app-181ac482": { kind: "missing-dir" },
        "/home/u/projects/app-181ac482/sub": { kind: "missing-dir" },
      }),
    });

    await expect(
      linker.resolveProjectPath("/home/u/projects/app-181ac482/sub"),
    ).resolves.toBe("/home/u/projects/app");
  });

  it("leaves standalone repositories and unrelated directories unlinked", async () => {
    const linker = createConversationLinker({
      projects,
      sessions: {},
      inspectGitDir: fakeInspector({
        "/home/u/projects/app-website": { kind: "repo" },
      }),
    });

    await expect(
      linker.resolveProjectPath("/home/u/projects/app-website"),
    ).resolves.toBeNull();
    await expect(linker.resolveProjectPath("/tmp/scratch")).resolves.toBeNull();
  });
});

describe("createConversationLinker session resolution", () => {
  const sessions = {
    "claude-1": { type: "claude-local-terminal", sessionId: "claude-1" },
    "codex-ui": {
      type: "codex-local-terminal",
      sessionId: "codex-ui",
      codexSessionId: "thread-main",
      subagentsByThreadId: { "thread-sub": { threadId: "thread-sub" } },
    },
    "cursor-ui": {
      type: "cursor-agent",
      sessionId: "cursor-ui",
      cursorChatId: "chat-1",
    },
  } as unknown as Record<string, Session>;

  const linker = createConversationLinker({
    projects: [],
    sessions,
    inspectGitDir: fakeInspector({}),
  });

  const base = {
    parentNativeId: null,
    relation: "main" as const,
    cwd: null,
  };

  it("matches each agent's native id field", () => {
    expect(
      linker.resolveAgentUiSessionId({
        ...base,
        agent: "claude",
        nativeId: "claude-1",
      }),
    ).toBe("claude-1");
    expect(
      linker.resolveAgentUiSessionId({
        ...base,
        agent: "codex",
        nativeId: "thread-main",
      }),
    ).toBe("codex-ui");
    expect(
      linker.resolveAgentUiSessionId({
        ...base,
        agent: "codex",
        nativeId: "thread-sub",
      }),
    ).toBe("codex-ui");
    expect(
      linker.resolveAgentUiSessionId({
        ...base,
        agent: "cursor",
        nativeId: "chat-1",
      }),
    ).toBe("cursor-ui");
    expect(
      linker.resolveAgentUiSessionId({
        ...base,
        agent: "cursor",
        nativeId: "claude-1",
      }),
    ).toBeNull();
  });

  it("links subagents through their parent conversation", () => {
    expect(
      linker.resolveAgentUiSessionId({
        agent: "claude",
        nativeId: "a1b2",
        parentNativeId: "claude-1",
        relation: "subagent",
        cwd: null,
      }),
    ).toBe("claude-1");
    expect(
      linker.resolveAgentUiSessionId({
        agent: "claude",
        nativeId: "fork-1",
        parentNativeId: "claude-1",
        relation: "fork",
        cwd: null,
      }),
    ).toBeNull();
  });
});

describe("inspectGitDir", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("distinguishes repositories, worktrees, plain and missing directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-ui-linking-"));
    dirs.push(root);
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "repo-feature");
    await mkdir(path.join(repo, ".git", "worktrees", "repo-feature"), {
      recursive: true,
    });
    await mkdir(worktree);
    await writeFile(
      path.join(worktree, ".git"),
      `gitdir: ${path.join(repo, ".git", "worktrees", "repo-feature")}\n`,
    );

    await expect(inspectGitDir(repo)).resolves.toEqual({ kind: "repo" });
    await expect(inspectGitDir(worktree)).resolves.toEqual({
      kind: "worktree",
      originPath: repo,
    });
    await expect(inspectGitDir(root)).resolves.toEqual({ kind: "none" });
    await expect(inspectGitDir(path.join(root, "gone"))).resolves.toEqual({
      kind: "missing-dir",
    });
  });
});
