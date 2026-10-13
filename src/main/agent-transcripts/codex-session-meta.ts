import { asRecord, asString } from "./json";

/** Forked rollouts open with copies of the parent's lines, written within this gap of each other. */
export const CODEX_FORK_COPY_MAX_GAP_MS = 1000;

function threadSpawnParentId(payload: Record<string, unknown>): string | null {
  const subagent = asRecord(asRecord(payload.source)?.subagent);
  return asString(asRecord(subagent?.thread_spawn)?.parent_thread_id);
}

export function isForkedSessionMeta(payload: Record<string, unknown>): boolean {
  return (
    typeof payload.forked_from_id === "string" ||
    threadSpawnParentId(payload) !== null
  );
}

export function codexSessionId(
  payload: Record<string, unknown>,
): string | null {
  return asString(payload.id) ?? asString(payload.session_id);
}

export function codexParentThreadId(
  payload: Record<string, unknown>,
): string | null {
  return (
    threadSpawnParentId(payload) ??
    asString(payload.forked_from_id) ??
    asString(payload.parent_thread_id)
  );
}

export function isCodexSubagentSessionMeta(
  payload: Record<string, unknown>,
): boolean {
  const source = asRecord(payload.source);
  return (
    (source !== null && source.subagent !== undefined) ||
    payload.thread_source === "subagent"
  );
}
