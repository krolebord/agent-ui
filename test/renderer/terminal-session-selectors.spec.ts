import { describe, expect, it } from "vitest";
import {
  buildProjectPickerOptions,
  buildProjectSessionGroups,
  getProjectDisplayName,
  groupHasAwaitingUserInput,
  isAwaitingUserInputStatus,
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
        isWorktree: false,
        worktreeOriginName: undefined,
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
        isWorktree: true,
        worktreeOriginName: "app",
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

describe("buildProjectPickerOptions", () => {
  it("keeps project order and carries alias, worktree, hidden and lock flags", () => {
    expect(
      buildProjectPickerOptions({
        projects: [
          { path: "/workspace/app", collapsed: false, alias: "App" },
          { path: "/workspace/hidden", collapsed: false, hidden: true },
          {
            path: "/workspace/app-wt",
            collapsed: false,
            worktreeOriginPath: "/workspace/app",
          },
          {
            path: "/workspace/locked",
            collapsed: false,
            interactionDisabled: true,
          },
        ],
        selectedPath: "/workspace/app",
      }),
    ).toEqual([
      {
        path: "/workspace/app",
        label: "App (app)",
        isWorktree: false,
        hidden: false,
        disabled: false,
        unlisted: false,
      },
      {
        path: "/workspace/hidden",
        label: "hidden",
        isWorktree: false,
        hidden: true,
        disabled: false,
        unlisted: false,
      },
      {
        path: "/workspace/app-wt",
        label: "app-wt",
        isWorktree: true,
        hidden: false,
        disabled: false,
        unlisted: false,
      },
      {
        path: "/workspace/locked",
        label: "locked",
        isWorktree: false,
        hidden: false,
        disabled: true,
        unlisted: false,
      },
    ]);
  });

  it("prepends a selected path that is not in the project list", () => {
    const options = buildProjectPickerOptions({
      projects: [{ path: "/workspace/app", collapsed: false }],
      selectedPath: "/workspace/gone",
    });

    expect(options[0]).toEqual({
      path: "/workspace/gone",
      label: "gone",
      isWorktree: false,
      hidden: false,
      disabled: false,
      unlisted: true,
    });
    expect(options).toHaveLength(2);
  });

  it("adds no entry when nothing is selected", () => {
    expect(
      buildProjectPickerOptions({
        projects: [{ path: "/workspace/app", collapsed: false }],
        selectedPath: "   ",
      }).map((option) => option.path),
    ).toEqual(["/workspace/app"]);
  });
});
