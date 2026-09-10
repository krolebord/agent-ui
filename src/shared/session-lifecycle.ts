import type { SessionStatus } from "@main/sessions/common";
import { sessionNeedsAttention } from "./session-attention";

export type SettledOverride = "settled" | "active";

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

export function inboxRowNeedsAttention(
  session: Pick<InboxLifecycleSession, "status">,
): boolean {
  return (
    sessionNeedsAttention(session.status) ||
    resolveInboxStatus(session) === "failed"
  );
}

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

export function resolveSettledTimestamp(
  session: InboxLifecycleSession,
): number {
  return session.settledAt ?? session.lastActivityAt;
}

export function canSnoozeSession(
  session: Pick<InboxLifecycleSession, "status">,
): boolean {
  return resolveInboxStatus(session) !== "approval";
}

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

export function sessionWokeFromSnooze(
  session: InboxLifecycleSession,
  now: number,
): boolean {
  return session.snoozedUntil !== undefined && !isSessionSnoozed(session, now);
}

export function resolveSnoozeWakeTimestamp(
  session: InboxLifecycleSession,
): number {
  return session.snoozedUntil ?? session.lastActivityAt;
}

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
