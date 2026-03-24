import { describe, expect, it } from "vitest";
import type { Services } from "../../src/main/create-services";
import { moveStoppedSessionToProject } from "../../src/main/move-stopped-session-to-project";
import type { ClaudeLocalTerminalSessionData } from "../../src/main/session-service";
import type {
  Session,
  SessionServiceState,
} from "../../src/main/sessions/state";

function buildContext(session: Session): {
  context: Services;
  sessionsMap: Record<string, Session>;
} {
  const sessionsMap: Record<string, Session> = {
    [session.sessionId]: { ...session },
  };
  const sessionsState = {
    state: sessionsMap,
    updateState: (updater: (draft: typeof sessionsMap) => void) => {
      updater(sessionsMap);
    },
  } as unknown as SessionServiceState;

  const context = {
    projectsState: {
      state: [{ path: "/proj/a" }, { path: "/proj/b" }],
    },
    sessions: {
      state: sessionsState,
    },
  } as unknown as Services;

  return { context, sessionsMap };
}

function baseSession(
  overrides: Partial<ClaudeLocalTerminalSessionData> = {},
): ClaudeLocalTerminalSessionData {
  return {
    sessionId: "s1",
    type: "claude-local-terminal",
    createdAt: 1,
    lastActivityAt: 1,
    status: "stopped",
    title: "T",
    startupConfig: {
      cwd: "/proj/a",
      permissionMode: "default",
      model: "opus",
      initialPrompt: undefined,
    },
    bufferedOutput: "",
    ...overrides,
  };
}

describe("moveStoppedSessionToProject", () => {
  it("updates cwd when session is stopped", () => {
    const session = baseSession();
    const { context, sessionsMap } = buildContext(session);

    moveStoppedSessionToProject(context, "s1", "/proj/b");

    expect(sessionsMap.s1?.startupConfig.cwd).toBe("/proj/b");
  });

  it("no-ops when target equals current cwd", () => {
    const session = baseSession();
    const { context, sessionsMap } = buildContext(session);

    moveStoppedSessionToProject(context, "s1", "/proj/a");

    expect(sessionsMap.s1?.startupConfig.cwd).toBe("/proj/a");
  });

  it("throws when session is running", () => {
    const session = baseSession({ status: "running" });
    const { context } = buildContext(session);

    expect(() => moveStoppedSessionToProject(context, "s1", "/proj/b")).toThrow(
      /Only stopped sessions/,
    );
  });

  it("throws when target is not a tracked project", () => {
    const session = baseSession();
    const { context } = buildContext(session);

    expect(() =>
      moveStoppedSessionToProject(context, "s1", "/unknown"),
    ).toThrow(/tracked project/);
  });

  it("throws for worktree-setup sessions", () => {
    const session: Session = {
      sessionId: "wt-1",
      type: "worktree-setup",
      createdAt: 1,
      lastActivityAt: 1,
      status: "stopped",
      title: "Worktree setup",
      startupConfig: { cwd: "/proj/a", projectRoot: "/proj/root" },
      steps: [],
    };
    const { context } = buildContext(session);

    expect(() =>
      moveStoppedSessionToProject(context, "wt-1", "/proj/b"),
    ).toThrow(/cannot be moved between projects/);
  });
});
