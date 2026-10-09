import type { SessionStatus } from "@main/sessions/common";
import type { Session } from "@main/sessions/state";
import type { UsageEntry } from "@main/usage-tracking";
import {
  describePromptSchedule,
  getPromptResetAt,
  getPromptUsageWindows,
  getRunningPromptSources,
} from "@shared/scheduled-prompts";
import { describe, expect, it } from "vitest";

const SHORT = "2026-10-05T15:00:00Z";
const WEEKLY = "2026-10-10T12:00:00Z";
const base = {
  accountId: null,
  status: "ok",
  error: null,
  fetchedAt: 1,
  refreshing: false,
} satisfies Partial<UsageEntry>;

describe("prompt usage windows", () => {
  it("finds Codex windows by duration regardless of primary/secondary ordering", () => {
    const entry: UsageEntry = {
      ...base,
      provider: "codex",
      data: {
        primaryWindow: {
          windowSeconds: 7 * 24 * 60 * 60,
          utilization: 90,
          resetsAt: WEEKLY,
        },
        secondaryWindow: {
          windowSeconds: 5 * 60 * 60,
          utilization: 20,
          resetsAt: SHORT,
        },
      },
    };
    expect(getPromptResetAt(entry, "short")).toBe(Date.parse(SHORT));
    expect(getPromptResetAt(entry, "weekly")).toBe(Date.parse(WEEKLY));
  });

  it("does not mislabel other Codex durations or invalid reset timestamps", () => {
    const entry: UsageEntry = {
      ...base,
      provider: "codex",
      data: {
        primaryWindow: {
          windowSeconds: 60 * 60,
          utilization: 20,
          resetsAt: SHORT,
        },
        secondaryWindow: {
          windowSeconds: 7 * 24 * 60 * 60,
          utilization: 90,
          resetsAt: "invalid",
        },
      },
    };
    expect(getPromptResetAt(entry, "short")).toBeNull();
    expect(getPromptResetAt(entry, "weekly")).toBeNull();
    expect(getPromptResetAt(undefined, "short")).toBeNull();
  });

  it("checks Sonnet's separate weekly limit only for Sonnet sessions", () => {
    const entry: UsageEntry = {
      ...base,
      provider: "claude",
      data: {
        five_hour: { utilization: 20, resets_at: SHORT },
        seven_day: { utilization: 30, resets_at: WEEKLY },
        seven_day_sonnet: { utilization: 100, resets_at: WEEKLY },
        extra_usage: null,
      },
    };
    expect(
      getPromptUsageWindows(entry, "opus").some(
        (window) => window.utilization >= 100,
      ),
    ).toBe(false);
    expect(
      getPromptUsageWindows(entry, "sonnet").some(
        (window) => window.utilization >= 100,
      ),
    ).toBe(true);
  });
});

describe("running prompt source choices", () => {
  function session(
    sessionId: string,
    status: SessionStatus,
    turn: Session["turn"] = { id: sessionId, status: "running" },
  ): Session {
    return {
      sessionId,
      type: "claude-local-terminal",
      title: sessionId,
      createdAt: 1,
      lastActivityAt: 1,
      status,
      turn,
      startupConfig: {
        cwd: "/var/tmp/project",
        model: "opus",
        permissionMode: "default",
        initialPrompt: undefined,
      },
    };
  }

  it("lists only other actively working agent sessions", () => {
    const statuses: SessionStatus[] = [
      "idle",
      "starting",
      "stopping",
      "awaiting_user_response",
      "awaiting_approval",
      "stopped",
      "error",
    ];
    const choices = [
      session("target", "running"),
      session("working", "running"),
      ...statuses.map((status) => session(status, status)),
      session("interrupted", "running", { id: "old", status: "interrupted" }),
    ];
    expect(
      getRunningPromptSources(choices, "target").map(
        (choice) => choice.sessionId,
      ),
    ).toEqual(["working"]);
  });

  it("excludes plain terminals and worktree setup even when running", () => {
    const agent = session("working", "running");
    const terminal: Session = {
      ...agent,
      type: "local-terminal",
      startupConfig: { cwd: "/var/tmp/project" },
    };
    const setup: Session = {
      ...agent,
      type: "worktree-setup",
      startupConfig: {
        cwd: "/var/tmp/project",
        projectRoot: "/var/tmp/project",
      },
      steps: [],
    };
    expect(getRunningPromptSources([terminal, setup], "target")).toEqual([]);
    expect(getRunningPromptSources([], "target")).toEqual([]);
  });

  it("describes the saved dependency by its source title", () => {
    expect(
      describePromptSchedule({
        kind: "after-session",
        sourceSessionId: "source",
        sourceTurnId: "turn",
        sourceTitle: "Build API",
        completed: false,
      }),
    ).toBe('After "Build API" finishes its current turn');
  });
});
