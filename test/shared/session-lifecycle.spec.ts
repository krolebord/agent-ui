import { describe, expect, it } from "vitest";
import type { SessionStatus } from "../../src/main/sessions/common";
import {
  canSettleSession,
  canSnoozeSession,
  type InboxLifecycleSession,
  inboxRowNeedsAttention,
  isSessionSettled,
  isSessionSnoozed,
  partitionInboxSessions,
  resolveInboxStatus,
  resolveNextActiveSessionId,
  resolveNextSnoozeWakeAt,
  sessionRaisedHandWhileSnoozed,
  sessionWokeFromSnooze,
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

/** NOW sits between the snooze (2_000) and the wake time (10_000). */
const NOW = 5_000;

/** A snoozed session: parked at 2_000, due to wake at 10_000. */
function snoozed(
  overrides: Partial<InboxLifecycleSession> & { sessionId: string },
): InboxLifecycleSession {
  return session({
    status: "idle",
    lastActivityAt: 1_000,
    snoozedAt: 2_000,
    snoozedUntil: 10_000,
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
  });

  it("allows finished, failed, resting, and stopping sessions", () => {
    // Settling an unread finished session counts as acknowledging it.
    expect(canSettleSession({ status: "awaiting_user_response" })).toBe(true);
    expect(canSettleSession({ status: "error" })).toBe(true);
    expect(canSettleSession({ status: "idle" })).toBe(true);
    expect(canSettleSession({ status: "stopped" })).toBe(true);
    // Stopping is intentional teardown (often settle itself), not live work.
    expect(canSettleSession({ status: "stopping" })).toBe(true);
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
    // Stopping is treated like stopped for settle, and intentional stops do
    // not bump lastActivityAt, so the timestamp check still holds.
    expect(
      isSessionSettled(
        settled({
          sessionId: "a",
          status: "stopping",
          lastActivityAt: 1_000,
        }),
      ),
    ).toBe(true);
  });

  it("still un-settles stopping rows when activity is newer", () => {
    expect(
      isSessionSettled(
        settled({
          sessionId: "a",
          status: "stopping",
          lastActivityAt: 9_999,
        }),
      ),
    ).toBe(false);
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

describe("canSnoozeSession", () => {
  it("refuses only a pending approval", () => {
    expect(canSnoozeSession({ status: "awaiting_approval" })).toBe(false);
  });

  it("allows a working session — snooze stops it, then parks until wake", () => {
    expect(canSnoozeSession({ status: "running" })).toBe(true);
    expect(canSnoozeSession({ status: "starting" })).toBe(true);
    expect(canSnoozeSession({ status: "stopping" })).toBe(true);
  });

  it("allows finished, failed and resting sessions", () => {
    expect(canSnoozeSession({ status: "awaiting_user_response" })).toBe(true);
    expect(canSnoozeSession({ status: "error" })).toBe(true);
    expect(canSnoozeSession({ status: "idle" })).toBe(true);
    expect(canSnoozeSession({ status: "stopped" })).toBe(true);
  });
});

describe("isSessionSnoozed", () => {
  it("hides a session whose wake time is still ahead", () => {
    expect(isSessionSnoozed(snoozed({ sessionId: "a" }), NOW)).toBe(true);
  });

  it("stops hiding once the wake time passes, with no event to drive it", () => {
    expect(isSessionSnoozed(snoozed({ sessionId: "a" }), 10_000)).toBe(false);
    expect(isSessionSnoozed(snoozed({ sessionId: "a" }), 10_001)).toBe(false);
  });

  it("never hides a session with no snooze state", () => {
    expect(isSessionSnoozed(session({ sessionId: "a" }), NOW)).toBe(false);
  });

  it("never hides on malformed wake data", () => {
    expect(
      isSessionSnoozed(snoozed({ sessionId: "a", snoozedUntil: NaN }), NOW),
    ).toBe(false);
    expect(
      isSessionSnoozed(
        snoozed({ sessionId: "a", snoozedUntil: Number.POSITIVE_INFINITY }),
        NOW,
      ),
    ).toBe(false);
  });

  it("stays snoozed while the session is still working", () => {
    // Teardown after snooze briefly leaves status as working (`stopping`);
    // in motion is not a conclusion, so activity bumps must not undo the park.
    expect(
      isSessionSnoozed(
        snoozed({ sessionId: "a", status: "running", lastActivityAt: 4_000 }),
        NOW,
      ),
    ).toBe(true);
  });

  it("wakes early when the agent ends up blocked on the user", () => {
    for (const status of [
      "awaiting_approval",
      "awaiting_user_response",
    ] as const) {
      expect(isSessionSnoozed(snoozed({ sessionId: "a", status }), NOW)).toBe(
        false,
      );
    }
  });

  it("wakes early when the session concludes after the snooze", () => {
    expect(
      isSessionSnoozed(
        snoozed({ sessionId: "a", status: "idle", lastActivityAt: 4_000 }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isSessionSnoozed(
        snoozed({ sessionId: "a", status: "error", lastActivityAt: 4_000 }),
        NOW,
      ),
    ).toBe(false);
  });

  it("stays snoozed when the failure predates the snooze — the user saw it", () => {
    expect(
      isSessionSnoozed(
        snoozed({ sessionId: "a", status: "error", lastActivityAt: 1_500 }),
        NOW,
      ),
    ).toBe(true);
  });

  it("stays snoozed when activity lands on the snooze instant", () => {
    expect(
      isSessionSnoozed(
        snoozed({ sessionId: "a", status: "idle", lastActivityAt: 2_000 }),
        NOW,
      ),
    ).toBe(true);
  });
});

describe("sessionRaisedHandWhileSnoozed", () => {
  it("is false for a quiet snoozed session", () => {
    expect(sessionRaisedHandWhileSnoozed(snoozed({ sessionId: "a" }))).toBe(
      false,
    );
  });

  it("needs no timestamp to wake blocked-on-you work", () => {
    // Deliberately independent of lastActivityAt: a write site that forgets to
    // bump it must not be able to bury a session that is waiting on the user.
    expect(
      sessionRaisedHandWhileSnoozed(
        snoozed({
          sessionId: "a",
          status: "awaiting_user_response",
          snoozedAt: undefined,
          lastActivityAt: 0,
        }),
      ),
    ).toBe(true);
  });
});

describe("sessionWokeFromSnooze", () => {
  it("marks a session that woke but has not been visited", () => {
    expect(sessionWokeFromSnooze(snoozed({ sessionId: "a" }), 10_001)).toBe(
      true,
    );
  });

  it("does not mark a session that is still snoozed", () => {
    expect(sessionWokeFromSnooze(snoozed({ sessionId: "a" }), NOW)).toBe(false);
  });

  it("does not mark a session that never snoozed", () => {
    expect(sessionWokeFromSnooze(session({ sessionId: "a" }), NOW)).toBe(false);
  });
});

describe("resolveNextSnoozeWakeAt", () => {
  it("returns the earliest upcoming wake", () => {
    expect(
      resolveNextSnoozeWakeAt(
        [
          snoozed({ sessionId: "late", snoozedUntil: 30_000 }),
          snoozed({ sessionId: "soon", snoozedUntil: 9_000 }),
          snoozed({ sessionId: "mid", snoozedUntil: 20_000 }),
        ],
        NOW,
      ),
    ).toBe(9_000);
  });

  it("ignores sessions that are no longer snoozed", () => {
    expect(
      resolveNextSnoozeWakeAt(
        [
          session({ sessionId: "awake" }),
          snoozed({ sessionId: "woke-early", status: "awaiting_approval" }),
        ],
        NOW,
      ),
    ).toBeNull();
  });

  it("returns null when nothing is waiting on a clock", () => {
    expect(resolveNextSnoozeWakeAt([], NOW)).toBeNull();
  });
});

describe("partitionInboxSessions", () => {
  it("sorts active newest-first by creation, never by activity", () => {
    const result = partitionInboxSessions(
      [
        session({ sessionId: "old", createdAt: 1_000, lastActivityAt: 9_999 }),
        session({ sessionId: "new", createdAt: 3_000, lastActivityAt: 1_000 }),
        session({ sessionId: "mid", createdAt: 2_000, lastActivityAt: 5_000 }),
      ],
      NOW,
    );

    expect(result.active.map((entry) => entry.sessionId)).toEqual([
      "new",
      "mid",
      "old",
    ]);
    expect(result.settled).toEqual([]);
  });

  it("breaks creation ties deterministically", () => {
    const result = partitionInboxSessions(
      [
        session({ sessionId: "b", createdAt: 1_000 }),
        session({ sessionId: "a", createdAt: 1_000 }),
      ],
      NOW,
    );

    expect(result.active.map((entry) => entry.sessionId)).toEqual(["a", "b"]);
  });

  it("sorts the settled shelf by when each was parked", () => {
    const result = partitionInboxSessions(
      [
        settled({ sessionId: "first", settledAt: 2_000 }),
        settled({ sessionId: "last", settledAt: 4_000 }),
        settled({ sessionId: "middle", settledAt: 3_000 }),
      ],
      NOW,
    );

    expect(result.settled.map((entry) => entry.sessionId)).toEqual([
      "last",
      "middle",
      "first",
    ]);
    expect(result.active).toEqual([]);
  });

  it("returns a session whose override went stale to the active list", () => {
    const result = partitionInboxSessions(
      [
        settled({ sessionId: "woken", lastActivityAt: 5_000 }),
        settled({ sessionId: "parked" }),
      ],
      NOW,
    );

    expect(result.active.map((entry) => entry.sessionId)).toEqual(["woken"]);
    expect(result.settled.map((entry) => entry.sessionId)).toEqual(["parked"]);
  });

  it("sorts the snoozed shelf by soonest wake", () => {
    const result = partitionInboxSessions(
      [
        snoozed({ sessionId: "last", snoozedUntil: 30_000 }),
        snoozed({ sessionId: "first", snoozedUntil: 9_000 }),
        snoozed({ sessionId: "middle", snoozedUntil: 20_000 }),
      ],
      NOW,
    );

    expect(result.snoozed.map((entry) => entry.sessionId)).toEqual([
      "first",
      "middle",
      "last",
    ]);
    expect(result.active).toEqual([]);
  });

  it("puts a snoozed session on the shelf even when it would also settle", () => {
    const result = partitionInboxSessions(
      [
        snoozed({
          sessionId: "both",
          settledAt: 2_000,
          settledOverride: "settled",
        }),
      ],
      NOW,
    );

    expect(result.snoozed.map((entry) => entry.sessionId)).toEqual(["both"]);
    expect(result.settled).toEqual([]);
  });

  it("returns a woken session to the active list, not the shelf", () => {
    const result = partitionInboxSessions(
      [
        snoozed({ sessionId: "woke", snoozedUntil: 4_000 }),
        snoozed({ sessionId: "asleep", snoozedUntil: 30_000 }),
      ],
      NOW,
    );

    expect(result.active.map((entry) => entry.sessionId)).toEqual(["woke"]);
    expect(result.snoozed.map((entry) => entry.sessionId)).toEqual(["asleep"]);
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
