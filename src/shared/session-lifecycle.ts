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
  snoozedUntil?: number | undefined;
  snoozedAt?: number | undefined;
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
 *
 * `stopping` is treated like `stopped` for settle: it is only reached by an
 * intentional teardown (often settle itself), not live work that must stay
 * visible.
 */
export function isSessionSettleBlocked(
  session: Pick<InboxLifecycleSession, "status">,
): boolean {
  if (session.status === "stopping") {
    return false;
  }
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
 * `stopping` is not a blocker (see `isSessionSettleBlocked`): settle stops the
 * live process, and intentional stops do not bump `lastActivityAt`, so the row
 * stays parked through teardown without a special case here.
 *
 * Past the blockers, the override only counts while it is newer than the
 * session's last activity. That comparison is what un-settles on activity:
 * activity monitors and unexpected process exits bump `lastActivityAt`, so a
 * settled session that starts working, errors, or crashes returns to the
 * active list on its own — no write path, and no status write site to keep in
 * sync. Intentional stops do not bump, so settle-driven teardown cannot bounce
 * the row back out.
 */
export function isSessionSettled(session: InboxLifecycleSession): boolean {
  if (session.settledOverride !== "settled") {
    return false;
  }
  if (session.settledAt === undefined) {
    return false;
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

/**
 * Snooze is only blocked by a pending approval. Unlike settle, a *working*
 * session is snoozable on purpose: snooze stops the live process (same as
 * settle) and parks the row until the wake time, so "not now, come back later"
 * works even while the agent is still in motion.
 *
 * `input` is snoozable for the same reason it is settleable — it conflates
 * "asked you something" with "finished, unread" — and `sessions.snooze` clears
 * it to `idle` so the unread flag cannot immediately wake the row again.
 */
export function canSnoozeSession(
  session: Pick<InboxLifecycleSession, "status">,
): boolean {
  return resolveInboxStatus(session) !== "approval";
}

/**
 * What outranks the user's "not now" and wakes a snoozed session early.
 *
 * The distinction snooze needs — and settle does not — is *started* versus
 * *concluded*. `lastActivityAt` bumps for both, so it cannot carry the
 * difference alone; the status supplies it:
 *
 * - `approval` / `input`: the agent is blocked on the user. Always wakes, with
 *   no timestamp comparison, so it holds even if a write site forgets to bump
 *   `lastActivityAt`. Safe against self-triggering because snoozing clears
 *   `input`, and `approval` cannot be snoozed in the first place.
 * - `working`: in motion is not a conclusion. Never wakes — covers the brief
 *   `stopping` window after snooze tears down the live process, and any
 *   activity bumps that would otherwise undo the park mid-teardown.
 * - `failed` / `ready`: a conclusion, but only if it happened *after* the
 *   snooze. A session parked while already broken or already finished stays
 *   parked; that was the user saying "I saw it, not now".
 */
export function sessionRaisedHandWhileSnoozed(
  session: InboxLifecycleSession,
): boolean {
  const status = resolveInboxStatus(session);
  if (status === "approval" || status === "input") {
    return true;
  }
  if (status === "working") {
    return false;
  }
  if (session.snoozedAt === undefined) {
    return false;
  }
  return session.lastActivityAt > session.snoozedAt;
}

/**
 * Snoozed resolution: hidden while the wake time is still ahead and nothing has
 * outranked the snooze.
 *
 * The timer wake is derived, exactly like settle's staleness rule — no event
 * fires when `snoozedUntil` passes, the fields simply stop classifying. Every
 * early return fails toward *visible*, so a missing, malformed or elapsed wake
 * time can never bury a session.
 */
export function isSessionSnoozed(
  session: InboxLifecycleSession,
  now: number,
): boolean {
  if (session.snoozedUntil === undefined) {
    return false;
  }
  if (!Number.isFinite(session.snoozedUntil)) {
    return false;
  }
  if (session.snoozedUntil <= now) {
    return false;
  }
  return !sessionRaisedHandWhileSnoozed(session);
}

/**
 * Whether a row should carry the "Woke" marker: it holds snooze fields but no
 * longer classifies as snoozed.
 *
 * No `lastVisitedAt` bookkeeping is needed for this because `sessions.markSeen`
 * clears the snooze when the session is opened, so a *lingering* `snoozedUntil`
 * is itself the "woke and not yet seen" signal.
 */
export function sessionWokeFromSnooze(
  session: InboxLifecycleSession,
  now: number,
): boolean {
  return session.snoozedUntil !== undefined && !isSessionSnoozed(session, now);
}

/**
 * When a snoozed row wakes, for sorting and for the "in 2h" label. Soonest
 * first is the shelf's question: what comes back next.
 */
export function resolveSnoozeWakeTimestamp(
  session: InboxLifecycleSession,
): number {
  return session.snoozedUntil ?? session.lastActivityAt;
}

/**
 * The next moment a partition could change on its own, or null when nothing is
 * waiting on a clock. Callers arm a single timer on this instead of polling —
 * the only clock-driven transition in the inbox is a snooze expiring.
 */
export function resolveNextSnoozeWakeAt(
  sessions: readonly InboxLifecycleSession[],
  now: number,
): number | null {
  let earliest: number | null = null;
  for (const session of sessions) {
    if (!isSessionSnoozed(session, now)) {
      continue;
    }
    const wakeAt = session.snoozedUntil;
    if (wakeAt === undefined) {
      continue;
    }
    if (earliest === null || wakeAt < earliest) {
      earliest = wakeAt;
    }
  }
  return earliest;
}

export interface InboxPartition<TSession> {
  active: TSession[];
  snoozed: TSession[];
  settled: TSession[];
}

/**
 * Splits sessions into the active list, the snoozed shelf and the settled
 * shelf.
 *
 * Active sort is deliberately static — newest first by creation, never
 * reordered by activity — so a row holds its position from open until settled
 * and the list only moves at lifecycle transitions. Status is carried by the
 * row's label, not by its position.
 *
 * Snooze is checked before settle: the two are written mutually exclusively, so
 * a session holding both markers is stale data, and the wake time is the
 * stronger statement about when it matters again.
 *
 * Snoozed rows order by soonest wake ("what comes back next"); settled rows are
 * history, so they order by when they were parked.
 */
export function partitionInboxSessions<TSession extends InboxLifecycleSession>(
  sessions: readonly TSession[],
  now: number,
): InboxPartition<TSession> {
  const active: TSession[] = [];
  const snoozed: TSession[] = [];
  const settled: TSession[] = [];

  for (const session of sessions) {
    if (isSessionSnoozed(session, now)) {
      snoozed.push(session);
      continue;
    }
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
  snoozed.sort(
    (left, right) =>
      resolveSnoozeWakeTimestamp(left) - resolveSnoozeWakeTimestamp(right) ||
      left.sessionId.localeCompare(right.sessionId),
  );
  settled.sort(
    (left, right) =>
      resolveSettledTimestamp(right) - resolveSettledTimestamp(left) ||
      left.sessionId.localeCompare(right.sessionId),
  );

  return { active, snoozed, settled };
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
