import { describe, expect, it } from "vitest";
import {
  buildProjectSessionGroups,
  buildProjectTree,
  buildWorktreeManagerRows,
  getProjectDisplayName,
  groupHasAwaitingUserInput,
  isAwaitingUserInputStatus,
  projectTreeNodeHoldsSelection,
  resolveProjectSelectionDisplay,
} from "../../src/renderer/src/services/terminal-session-selectors";

describe("buildProjectSessionGroups", () => {
  it("includes git branch metadata for regular projects", () => {
    const groups = buildProjectSessionGroups({
      projects: [
        {
          path: "/workspace/app",
          collapsed: false,
          gitBranch: "feature/sidebar-branch",
        },
      ],
      sessionsById: {},
    });

    expect(groups).toEqual([
      {
        path: "/workspace/app",
        displayName: "app",
        collapsed: false,
        hidden: false,
        fromProjectList: true,
        gitBranch: "feature/sidebar-branch",
        gitUpstreamDiffStats: undefined,
        isWorktree: false,
        worktreeOriginName: undefined,
        worktreeOriginPath: undefined,
        worktreeCount: 0,
        interactionDisabled: false,
        sessions: [],
      },
    ]);
  });

  it("exposes upstream ahead/behind stats for projects", () => {
    const groups = buildProjectSessionGroups({
      projects: [
        {
          path: "/workspace/app",
          collapsed: false,
          gitBranch: "main",
          gitUpstreamDiffStats: {
            upstreamBranch: "origin/main",
            aheadCommits: 3,
            behindCommits: 1,
          },
        },
      ],
      sessionsById: {},
    });

    expect(groups[0]?.gitUpstreamDiffStats).toEqual({
      upstreamBranch: "origin/main",
      aheadCommits: 3,
      behindCommits: 1,
    });
  });

  it("prefers alias display names and exposes worktree origin names", () => {
    const groups = buildProjectSessionGroups({
      projects: [
        {
          path: "/workspace/app-feature-sidebar",
          alias: "Sidebar Spike",
          collapsed: false,
          gitBranch: "feature/sidebar",
          worktreeOriginPath: "/workspace/app",
        },
      ],
      sessionsById: {},
    });

    expect(groups).toEqual([
      {
        path: "/workspace/app-feature-sidebar",
        displayName: "Sidebar Spike (app-feature-sidebar)",
        collapsed: false,
        hidden: false,
        fromProjectList: true,
        gitBranch: "feature/sidebar",
        gitUpstreamDiffStats: undefined,
        isWorktree: true,
        worktreeOriginName: "app",
        worktreeOriginPath: "/workspace/app",
        worktreeCount: 0,
        interactionDisabled: false,
        sessions: [],
      },
    ]);
  });

  it("marks hidden projects for sidebar filtering", () => {
    const groups = buildProjectSessionGroups({
      projects: [
        {
          path: "/workspace/hidden-app",
          collapsed: true,
          hidden: true,
        },
      ],
      sessionsById: {},
    });

    expect(groups[0]).toMatchObject({
      path: "/workspace/hidden-app",
      hidden: true,
    });
  });

  it("hides settled sessions from the project tree", () => {
    const groups = buildProjectSessionGroups({
      projects: [{ path: "/workspace/app", collapsed: false }],
      sessionsById: {
        active: {
          sessionId: "active",
          type: "claude-local-terminal",
          status: "idle",
          createdAt: 2_000,
          lastActivityAt: 2_000,
          startupConfig: { cwd: "/workspace/app" },
        },
        settled: {
          sessionId: "settled",
          type: "claude-local-terminal",
          status: "stopped",
          createdAt: 3_000,
          lastActivityAt: 1_000,
          settledAt: 2_000,
          settledOverride: "settled",
          startupConfig: { cwd: "/workspace/app" },
        },
      } as never,
    });

    expect(groups[0]?.sessions.map((session) => session.sessionId)).toEqual([
      "active",
    ]);
  });
});

describe("getProjectDisplayName", () => {
  it("shows alias with the original project folder name in parentheses", () => {
    expect(
      getProjectDisplayName({
        path: "/workspace/app",
        alias: "Core UI",
      }),
    ).toBe("Core UI (app)");
  });
});

describe("isAwaitingUserInputStatus", () => {
  it("matches both supported awaiting-user status values", () => {
    expect(isAwaitingUserInputStatus("awaiting_user_response")).toBe(true);
    expect(isAwaitingUserInputStatus("awaiting_user_reply")).toBe(true);
    expect(isAwaitingUserInputStatus("running")).toBe(false);
  });
});

describe("groupHasAwaitingUserInput", () => {
  it("returns true when any group session is awaiting user input", () => {
    expect(
      groupHasAwaitingUserInput({
        sessions: [
          {
            status: "running",
          },
          {
            status: "awaiting_user_response",
          },
        ] as never,
      }),
    ).toBe(true);
  });

  it("returns false when no group session is awaiting user input", () => {
    expect(
      groupHasAwaitingUserInput({
        sessions: [
          {
            status: "idle",
          },
          {
            status: "awaiting_approval",
          },
        ] as never,
      }),
    ).toBe(false);
  });
});

describe("buildProjectTree", () => {
  it("nests worktrees under their origin and keeps project order", () => {
    const tree = buildProjectTree({
      projects: [
        {
          path: "/workspace/app",
          collapsed: false,
          alias: "App",
          gitBranch: "main",
        },
        { path: "/workspace/hidden", collapsed: false, hidden: true },
        {
          path: "/workspace/app-feature",
          collapsed: false,
          gitBranch: "agent-ui/feature",
          worktreeOriginPath: "/workspace/app",
        },
        {
          path: "/workspace/locked",
          collapsed: false,
          interactionDisabled: true,
          gitBranch: "main",
        },
      ],
      selectedPath: "/workspace/app",
    });

    expect(tree.map((node) => node.path)).toEqual([
      "/workspace/app",
      "/workspace/hidden",
      "/workspace/locked",
    ]);
    expect(tree[0]).toMatchObject({
      label: "App (app)",
      branch: "main",
      canCreateWorktree: true,
      worktrees: [
        {
          path: "/workspace/app-feature",
          label: "agent-ui/feature",
          disabled: false,
        },
      ],
    });
    expect(tree[1]).toMatchObject({
      hidden: true,
      canCreateWorktree: false,
      worktrees: [],
    });
    expect(tree[2]).toMatchObject({ disabled: true, canCreateWorktree: false });
  });

  it("labels worktrees by alias before branch", () => {
    const tree = buildProjectTree({
      projects: [
        { path: "/workspace/app", collapsed: false, gitBranch: "main" },
        {
          path: "/workspace/app-1a2b3c4d",
          collapsed: false,
          alias: "Fix login redirect",
          gitBranch: "agent-ui/1a2b3c4d",
          worktreeOriginPath: "/workspace/app",
        },
      ],
      selectedPath: "/workspace/app-1a2b3c4d",
    });

    expect(tree).toHaveLength(1);
    expect(tree[0].worktrees[0].label).toBe("Fix login redirect");
  });

  it("keeps a worktree as its own node when the origin is untracked", () => {
    const tree = buildProjectTree({
      projects: [
        {
          path: "/workspace/app-feature",
          collapsed: false,
          gitBranch: "agent-ui/feature",
          worktreeOriginPath: "/workspace/gone",
        },
      ],
      selectedPath: "",
    });

    expect(tree).toEqual([
      {
        path: "/workspace/app-feature",
        label: "agent-ui/feature",
        branch: "agent-ui/feature",
        hidden: false,
        disabled: false,
        unlisted: false,
        canCreateWorktree: false,
        worktrees: [],
      },
    ]);
  });

  it("prepends a selected path that is not in the project list", () => {
    const tree = buildProjectTree({
      projects: [{ path: "/workspace/app", collapsed: false }],
      selectedPath: "/workspace/gone",
    });

    expect(tree[0]).toMatchObject({
      path: "/workspace/gone",
      label: "gone",
      unlisted: true,
    });
    expect(tree).toHaveLength(2);
  });

  it("adds no entry when nothing is selected", () => {
    expect(
      buildProjectTree({
        projects: [{ path: "/workspace/app", collapsed: false }],
        selectedPath: "   ",
      }).map((node) => node.path),
    ).toEqual(["/workspace/app"]);
  });
});

describe("buildWorktreeManagerRows", () => {
  const projects = [
    { path: "/workspace/app", collapsed: false, gitBranch: "main" },
    {
      path: "/workspace/app-feature",
      collapsed: false,
      gitBranch: "agent-ui/feature",
      worktreeOriginPath: "/workspace/app",
      gitDiffStats: { addedLines: 12, deletedLines: 3 },
      gitUpstreamDiffStats: {
        upstreamBranch: "origin/agent-ui/feature",
        aheadCommits: 2,
        behindCommits: 1,
      },
    },
    {
      path: "/workspace/app-idle",
      collapsed: false,
      gitBranch: "agent-ui/idle",
      worktreeOriginPath: "/workspace/app",
      interactionDisabled: true,
    },
    {
      path: "/workspace/other-wt",
      collapsed: false,
      worktreeOriginPath: "/workspace/other",
    },
  ];

  const sessionsById = {
    a: {
      sessionId: "a",
      status: "running",
      startupConfig: { cwd: "/workspace/app-feature" },
    },
    b: {
      sessionId: "b",
      status: "awaiting_user_response",
      startupConfig: { cwd: "/workspace/app-feature" },
    },
    c: {
      sessionId: "c",
      status: "stopped",
      settledOverride: "settled",
      settledAt: 2,
      lastActivityAt: 1,
      startupConfig: { cwd: "/workspace/app-feature" },
    },
    d: {
      sessionId: "d",
      status: "running",
      startupConfig: { cwd: "/workspace/app" },
    },
  } as never;

  it("lists only the worktrees of the given origin with live counters", () => {
    const rows = buildWorktreeManagerRows({
      projects,
      sessionsById,
      originPath: "/workspace/app",
    });

    expect(rows).toEqual([
      {
        path: "/workspace/app-feature",
        label: "agent-ui/feature",
        branch: "agent-ui/feature",
        activeSessionCount: 2,
        addedLines: 12,
        deletedLines: 3,
        upstreamBranch: "origin/agent-ui/feature",
        aheadCommits: 2,
        behindCommits: 1,
        removing: false,
      },
      {
        path: "/workspace/app-idle",
        label: "agent-ui/idle",
        branch: "agent-ui/idle",
        activeSessionCount: 0,
        addedLines: 0,
        deletedLines: 0,
        upstreamBranch: null,
        aheadCommits: 0,
        behindCommits: 0,
        removing: true,
      },
    ]);
  });

  it("returns nothing for a project without worktrees", () => {
    expect(
      buildWorktreeManagerRows({
        projects,
        sessionsById,
        originPath: "/workspace/app-feature",
      }),
    ).toEqual([]);
  });
});

describe("resolveProjectSelectionDisplay", () => {
  const projects = [
    { path: "/workspace/app", collapsed: false, gitBranch: "main" },
    {
      path: "/workspace/app-1a2b3c4d",
      collapsed: false,
      alias: "Fix login redirect",
      gitBranch: "agent-ui/1a2b3c4d",
      worktreeOriginPath: "/workspace/app",
    },
    { path: "/workspace/site", collapsed: false, gitBranch: "main" },
  ];

  it("shows the worktree alongside its origin when a worktree is selected", () => {
    const selection = {
      kind: "project" as const,
      path: "/workspace/app-1a2b3c4d",
    };
    const nodes = buildProjectTree({
      projects,
      selectedPath: "/workspace/app-1a2b3c4d",
    });

    expect(resolveProjectSelectionDisplay(nodes, selection)).toEqual({
      faviconPath: "/workspace/app",
      label: "app",
      detail: "Fix login redirect",
    });
    expect(projectTreeNodeHoldsSelection(nodes[0], selection)).toBe(true);
    expect(projectTreeNodeHoldsSelection(nodes[1], selection)).toBe(false);
  });

  it("shows a plain project without detail", () => {
    const nodes = buildProjectTree({
      projects,
      selectedPath: "/workspace/app",
    });

    expect(
      resolveProjectSelectionDisplay(nodes, {
        kind: "project",
        path: "/workspace/app",
      }),
    ).toEqual({
      faviconPath: "/workspace/app",
      label: "app",
      detail: null,
    });
  });

  it("marks a pending new worktree against its origin", () => {
    const selection = {
      kind: "new-worktree" as const,
      originPath: "/workspace/app",
    };
    const nodes = buildProjectTree({
      projects,
      selectedPath: "/workspace/app",
    });

    expect(resolveProjectSelectionDisplay(nodes, selection)).toEqual({
      faviconPath: "/workspace/app",
      label: "app",
      detail: "New worktree",
    });
    expect(projectTreeNodeHoldsSelection(nodes[0], selection)).toBe(true);
  });

  it("falls back to an unlisted node for an untracked path", () => {
    const nodes = buildProjectTree({
      projects,
      selectedPath: "/workspace/gone",
    });

    expect(
      resolveProjectSelectionDisplay(nodes, {
        kind: "project",
        path: "/workspace/gone",
      }),
    ).toEqual({
      faviconPath: "/workspace/gone",
      label: "gone",
      detail: null,
    });
  });
});
