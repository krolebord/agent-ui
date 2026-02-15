import { describe, expect, it } from "vitest";
import type { ClaudeSession } from "../../src/main/session-service";
import {
  buildProjectSessionGroups,
  getSessionLastActivityLabel,
  getSessionSidebarIndicatorState,
} from "../../src/renderer/src/services/terminal-session-selectors";

function makeSession(overrides?: Partial<ClaudeSession>): ClaudeSession {
  return {
    sessionId: "session-1",
    title: "Session session-",
    createdAt: Date.parse("2026-02-06T00:00:00.000Z"),
    lastActivityAt: Date.parse("2026-02-06T00:00:00.000Z"),
    activity: {
      state: "idle",
    },
    terminal: {
      status: "stopped",
    },
    startupConfig: {
      cwd: "/workspace",
      model: "opus",
      permissionMode: "default",
    },
    ...overrides,
  };
}

describe("terminal session selectors", () => {
  it("prioritizes error indicator over activity state", () => {
    expect(
      getSessionSidebarIndicatorState(
        makeSession({
          terminal: {
            status: "error",
          },
          activity: {
            state: "awaiting_approval",
          },
        }),
      ),
    ).toBe("error");
  });

  it("shows stopping indicator while terminal is shutting down", () => {
    expect(
      getSessionSidebarIndicatorState(
        makeSession({
          terminal: {
            status: "stopping",
          },
        }),
      ),
    ).toBe("stopping");
  });

  it("formats relative activity labels", () => {
    const now = Date.parse("2026-02-06T01:00:00.000Z");
    expect(
      getSessionLastActivityLabel(
        makeSession({ lastActivityAt: Date.parse("2026-02-06T00:56:00.000Z") }),
        now,
      ),
    ).toBe("4m");
  });

  it("uses one minute label for activity that rounds to 60 seconds", () => {
    const now = Date.parse("2026-02-06T01:00:59.000Z");
    expect(
      getSessionLastActivityLabel(
        makeSession({ lastActivityAt: Date.parse("2026-02-06T01:00:00.000Z") }),
        now,
      ),
    ).toBe("1m");
  });

  it("builds project groups with newest sessions first", () => {
    const groups = buildProjectSessionGroups({
      projects: [{ path: "/workspace", collapsed: false }],
      sessionsById: {
        "session-1": makeSession({
          sessionId: "session-1",
          createdAt: Date.parse("2026-02-06T00:00:00.000Z"),
          lastActivityAt: Date.parse("2026-02-06T00:00:00.000Z"),
        }),
        "session-2": makeSession({
          sessionId: "session-2",
          createdAt: Date.parse("2026-02-06T00:00:01.000Z"),
          lastActivityAt: Date.parse("2026-02-06T00:00:01.000Z"),
        }),
      },
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.sessions.map((session) => session.sessionId)).toEqual([
      "session-2",
      "session-1",
    ]);
  });
});
