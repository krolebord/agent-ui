import { describe, expect, it } from "vitest";
import type { SessionStatus } from "../../src/main/sessions/common";
import {
  canSettleSession,
  type InboxLifecycleSession,
  inboxRowNeedsAttention,
  isSessionSettled,
  partitionInboxSessions,
  resolveInboxStatus,
  resolveNextActiveSessionId,
} from "../../src/shared/session-lifecycle";

function session(
  overrides: Partial<InboxLifecycleSession> & { sessionId: string },
): InboxLifecycleSession {
  return {
    status: "stopped",
    createdAt: 1_000,
    lastActivityAt: 1_000,
    ...overrides,
  };
}

/** A settled session: parked after its last activity. */
function settled(
  overrides: Partial<InboxLifecycleSession> & { sessionId: string },
): InboxLifecycleSession {
  return session({
    lastActivityAt: 1_000,
    settledAt: 2_000,
    settledOverride: "settled",
    ...overrides,
  });
}

describe("resolveInboxStatus", () => {
  const cases: [SessionStatus, string][] = [
    ["awaiting_approval", "approval"],
    ["awaiting_user_response", "input"],
    ["starting", "working"],
    ["running", "working"],
    ["stopping", "working"],
    ["error", "failed"],
    ["idle", "ready"],
    ["stopped", "ready"],
  ];

  it.each(cases)("maps %s to %s", (status, expected) => {
    expect(resolveInboxStatus({ status })).toBe(expected);
  });
});

describe("inboxRowNeedsAttention", () => {
  it("lights up work blocked on the user and failures", () => {
    expect(inboxRowNeedsAttention({ status: "awaiting_approval" })).toBe(true);
    expect(inboxRowNeedsAttention({ status: "awaiting_user_response" })).toBe(
      true,
    );
    expect(inboxRowNeedsAttention({ status: "error" })).toBe(true);
  });

  it("lets in-flight and resting sessions recede", () => {
    expect(inboxRowNeedsAttention({ status: "running" })).toBe(false);
    expect(inboxRowNeedsAttention({ status: "starting" })).toBe(false);
    expect(inboxRowNeedsAttention({ status: "idle" })).toBe(false);
    expect(inboxRowNeedsAttention({ status: "stopped" })).toBe(false);
  });
});

describe("canSettleSession", () => {
  it("refuses approvals and work in motion", () => {
    expect(canSettleSession({ status: "awaiting_approval" })).toBe(false);
    expect(canSettleSession({ status: "running" })).toBe(false);
    expect(canSettleSession({ status: "starting" })).toBe(false);
    expect(canSettleSession({ status: "stopping" })).toBe(false);
  });

  it("allows finished, failed and resting sessions", () => {
    // Settling an unread finished session counts as acknowledging it.
    expect(canSettleSession({ status: "awaiting_user_response" })).toBe(true);
    expect(canSettleSession({ status: "error" })).toBe(true);
    expect(canSettleSession({ status: "idle" })).toBe(true);
    expect(canSettleSession({ status: "stopped" })).toBe(true);
  });
});

describe("isSessionSettled", () => {
  it("requires an explicit override", () => {
    expect(isSessionSettled(session({ sessionId: "a" }))).toBe(false);
    expect(
      isSessionSettled(session({ sessionId: "a", settledAt: 2_000 })),
    ).toBe(false);
    expect(isSessionSettled(settled({ sessionId: "a" }))).toBe(true);
  });

  it("ignores an override with no timestamp to anchor it", () => {
    expect(
      isSessionSettled(session({ sessionId: "a", settledOverride: "settled" })),
    ).toBe(false);
  });

  it("does not treat the keep-active pin as settled", () => {
    expect(
      isSessionSettled(settled({ sessionId: "a", settledOverride: "active" })),
    ).toBe(false);
  });

  it("un-settles when activity lands after the settle", () => {
    expect(
      isSessionSettled(settled({ sessionId: "a", lastActivityAt: 3_000 })),
    ).toBe(false);
  });

  it("stays settled when activity is older than the settle", () => {
    expect(
      isSessionSettled(settled({ sessionId: "a", lastActivityAt: 1_999 })),
    ).toBe(true);
  });

  it("stays settled when activity lands on the settle instant", () => {
    expect(
      isSessionSettled(settled({ sessionId: "a", lastActivityAt: 2_000 })),
    ).toBe(true);
  });

  it("never hides an approval or live work, override or not", () => {
    for (const status of [
      "awaiting_approval",
      "running",
      "starting",
    ] as const) {
      expect(isSessionSettled(settled({ sessionId: "a", status }))).toBe(false);
    }
  });

  it("keeps a settle-driven stop parked through the stopping window", () => {
    // Settling stops the process; stop bumps lastActivityAt while status is
    // briefly "stopping". The row must stay on the shelf through that race.
    expect(
      isSessionSettled(
        settled({
          sessionId: "a",
          status: "stopping",
          lastActivityAt: 9_999,
        }),
      ),
    ).toBe(true);
  });

  it("keeps failed and finished sessions settleable", () => {
    expect(isSessionSettled(settled({ sessionId: "a", status: "error" }))).toBe(
      true,
    );
    expect(
      isSessionSettled(
        settled({ sessionId: "a", status: "awaiting_user_response" }),
      ),
    ).toBe(true);
  });
});

describe("partitionInboxSessions", () => {
  it("sorts active newest-first by creation, never by activity", () => {
    const result = partitionInboxSessions([
      session({ sessionId: "old", createdAt: 1_000, lastActivityAt: 9_999 }),
      session({ sessionId: "new", createdAt: 3_000, lastActivityAt: 1_000 }),
      session({ sessionId: "mid", createdAt: 2_000, lastActivityAt: 5_000 }),
    ]);

    expect(result.active.map((entry) => entry.sessionId)).toEqual([
      "new",
      "mid",
      "old",
    ]);
    expect(result.settled).toEqual([]);
  });

  it("breaks creation ties deterministically", () => {
    const result = partitionInboxSessions([
      session({ sessionId: "b", createdAt: 1_000 }),
      session({ sessionId: "a", createdAt: 1_000 }),
    ]);

    expect(result.active.map((entry) => entry.sessionId)).toEqual(["a", "b"]);
  });

  it("sorts the settled shelf by when each was parked", () => {
    const result = partitionInboxSessions([
      settled({ sessionId: "first", settledAt: 2_000 }),
      settled({ sessionId: "last", settledAt: 4_000 }),
      settled({ sessionId: "middle", settledAt: 3_000 }),
    ]);

    expect(result.settled.map((entry) => entry.sessionId)).toEqual([
      "last",
      "middle",
      "first",
    ]);
    expect(result.active).toEqual([]);
  });

  it("returns a session whose override went stale to the active list", () => {
    const result = partitionInboxSessions([
      settled({ sessionId: "woken", lastActivityAt: 5_000 }),
      settled({ sessionId: "parked" }),
    ]);

    expect(result.active.map((entry) => entry.sessionId)).toEqual(["woken"]);
    expect(result.settled.map((entry) => entry.sessionId)).toEqual(["parked"]);
  });
});

describe("resolveNextActiveSessionId", () => {
  it("moves to the next session and wraps around", () => {
    expect(
      resolveNextActiveSessionId({
        activeSessionIds: ["a", "b", "c"],
        settledSessionId: "b",
      }),
    ).toBe("c");
    expect(
      resolveNextActiveSessionId({
        activeSessionIds: ["a", "b", "c"],
        settledSessionId: "c",
      }),
    ).toBe("a");
  });

  it("skips sessions leaving in the same action", () => {
    expect(
      resolveNextActiveSessionId({
        activeSessionIds: ["a", "b", "c"],
        settledSessionId: "a",
        alsoLeavingSessionIds: new Set(["b"]),
      }),
    ).toBe("c");
  });

  it("returns null when nothing is left to move to", () => {
    expect(
      resolveNextActiveSessionId({
        activeSessionIds: ["only"],
        settledSessionId: "only",
      }),
    ).toBeNull();
    expect(
      resolveNextActiveSessionId({
        activeSessionIds: ["a", "b"],
        settledSessionId: "missing",
      }),
    ).toBeNull();
  });
});
