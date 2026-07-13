export const attentionSessionStatuses = [
  "awaiting_user_response",
  "awaiting_approval",
] as const;

const attentionSessionStatusSet = new Set<string>(attentionSessionStatuses);

export function sessionNeedsAttention(status: string): boolean {
  return attentionSessionStatusSet.has(status);
}

export function countAttentionSessions(
  sessions: Iterable<{ status: string }>,
): number {
  let count = 0;
  for (const session of sessions) {
    if (sessionNeedsAttention(session.status)) {
      count += 1;
    }
  }
  return count;
}
