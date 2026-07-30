import type { SessionStatus } from "@main/sessions/common";
import { sessionNeedsAttention } from "./session-attention";

/**
 * Explicit settle marker. Only "settled" is written today; "active" is the
 * keep-active pin that auto-settle would need, and exists so the persisted
 * shape does not have to change when that lands.
 */
export type SettledOverride = "settled" | "active";

/**
 * The session fields the inbox lifecycle reasons about. Structural on purpose:
 * the rules stay pure and testable without constructing a full session from the
 * discriminated union, and every session type satisfies it via
 * `commonSessionSchema`.
 */
export interface InboxLifecycleSession {
  sessionId: string;
  status: SessionStatus;
  createdAt: number;
  lastActivityAt: number;
  settledAt?: number | undefined;
  settledOverride?: SettledOverride | undefined;
}

/**
 * Five states, three colors: color is reserved for "act now" (approval), "in
 * motion" (working) and "broken" (failed). "ready" is the unlabeled resting
 * state — the agent stopped and nothing is owed to the user.
 */
export type InboxStatus = "approval" | "input" | "working" | "failed" | "ready";

export function resolveInboxStatus(
  session: Pick<InboxLifecycleSession, "status">,
): InboxStatus {
  switch (session.status) {
    case "awaiting_approval":
      return "approval";
    case "awaiting_user_response":
      return "input";
    case "starting":
    case "running":
    case "stopping":
      return "working";
    case "error":
      return "failed";
    default:
      return "ready";
  }
}

/**
 * Whether a row stays fully lit while the rest recede. Built on the existing
 * attention set (the one behind the dock badge and favicon) plus failures, so
 * the inbox agrees with the rest of the app about what is urgent.
 */
export function inboxRowNeedsAttention(
  session: Pick<InboxLifecycleSession, "status">,
): boolean {
  return (
    sessionNeedsAttention(session.status) ||
    resolveInboxStatus(session) === "failed"
  );
}

/**
 * Work that must never be hidden: a pending approval (the agent is blocked on
 * an explicit yes/no) and anything still in motion (settling it would hide work
 * that is actively progressing).
 *
 * `input` is NOT here even though it also means "blocked on you": in this app
 * `awaiting_user_response` covers both "the agent asked something" and "the
 * agent finished and you haven't looked yet", and hiding a finished session is
 * the single most common inbox action. Settling one instead counts as
 * acknowledging it — `sessions.settle` clears the flag the same way
 * `sessions.markSeen` does, and also stops the live process.
 *
 * `failed` is settleable too: the error is already visible in the row, and
 * parking a broken session is a legitimate decision.
 */
export function isSessionSettleBlocked(
  session: Pick<InboxLifecycleSession, "status">,
): boolean {
  const status = resolveInboxStatus(session);
  return status === "approval" || status === "working";
}

export function canSettleSession(
  session: Pick<InboxLifecycleSession, "status">,
): boolean {
  return !isSessionSettleBlocked(session);
}

/**
 * Settled resolution.
 *
 * Blockers are checked first and hold a session out of the shelf regardless of
 * any stored override, so a settle can never bury an approval or live work.
 *
 * Exception: `stopping` is allowed through when the override is already set.
 * Settling stops the live process, and that stop briefly lands in `stopping`
 * (and bumps `lastActivityAt`) before `settledAt` can be re-stamped — without
 * this carve-out the row would flash back into the active list mid-settle.
 *
 * Past the blockers, the override only counts while it is newer than the
 * session's last activity. That comparison is what un-settles on activity:
 * every activity monitor already bumps `lastActivityAt`, so a settled session
 * that starts working, errors, or gets a reply returns to the active list on
 * its own — no write path, and no status write site to keep in sync.
 */
export function isSessionSettled(session: InboxLifecycleSession): boolean {
  if (session.settledOverride !== "settled") {
    return false;
  }
  if (session.settledAt === undefined) {
    return false;
  }

  if (session.status === "stopping") {
    return true;
  }

  if (isSessionSettleBlocked(session)) {
    return false;
  }

  return session.settledAt >= session.lastActivityAt;
}

/** The timestamp a settled row sorts and labels by: when it was parked. */
export function resolveSettledTimestamp(
  session: InboxLifecycleSession,
): number {
  return session.settledAt ?? session.lastActivityAt;
}

export interface InboxPartition<TSession> {
  active: TSession[];
  settled: TSession[];
}

/**
 * Splits sessions into the active list and the settled shelf.
 *
 * Active sort is deliberately static — newest first by creation, never
 * reordered by activity — so a row holds its position from open until settled
 * and the list only moves at lifecycle transitions. Status is carried by the
 * row's label, not by its position.
 *
 * Settled rows are history, so they order by when they were parked.
 */
export function partitionInboxSessions<TSession extends InboxLifecycleSession>(
  sessions: readonly TSession[],
): InboxPartition<TSession> {
  const active: TSession[] = [];
  const settled: TSession[] = [];

  for (const session of sessions) {
    if (isSessionSettled(session)) {
      settled.push(session);
      continue;
    }
    active.push(session);
  }

  active.sort(
    (left, right) =>
      right.createdAt - left.createdAt ||
      left.sessionId.localeCompare(right.sessionId),
  );
  settled.sort(
    (left, right) =>
      resolveSettledTimestamp(right) - resolveSettledTimestamp(left) ||
      left.sessionId.localeCompare(right.sessionId),
  );

  return { active, settled };
}

/**
 * Where focus goes when the session you are looking at gets parked: the next
 * remaining active session, wrapping to the top, skipping anything leaving in
 * the same action. Null when nothing is left to move to.
 */
export function resolveNextActiveSessionId(input: {
  activeSessionIds: readonly string[];
  settledSessionId: string;
  alsoLeavingSessionIds?: ReadonlySet<string>;
}): string | null {
  const { activeSessionIds, alsoLeavingSessionIds, settledSessionId } = input;
  const currentIndex = activeSessionIds.indexOf(settledSessionId);
  if (currentIndex === -1) {
    return null;
  }

  const ordered = [
    ...activeSessionIds.slice(currentIndex + 1),
    ...activeSessionIds.slice(0, currentIndex),
  ];

  return (
    ordered.find(
      (sessionId) =>
        sessionId !== settledSessionId &&
        alsoLeavingSessionIds?.has(sessionId) !== true,
    ) ?? null
  );
}
