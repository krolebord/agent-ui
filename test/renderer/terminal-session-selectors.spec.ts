import { describe, expect, it } from "vitest";
import {
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
