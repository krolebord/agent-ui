import { describe, expect, it } from "vitest";
import {
  buildProjectSessionGroups,
  getProjectDisplayName,
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
        fromProjectList: true,
        gitBranch: "feature/sidebar-branch",
        isWorktree: false,
        worktreeOriginName: undefined,
        sessions: [],
      },
    ]);
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
        fromProjectList: true,
        gitBranch: "feature/sidebar",
        isWorktree: true,
        worktreeOriginName: "app",
        sessions: [],
      },
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
