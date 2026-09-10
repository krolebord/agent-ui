import { cursorDedupeKey } from "./cursor-events";
import type { UsageRecord } from "./transcripts";

const CURSOR_CACHE_VERSION = 1 as const;

export interface CursorCacheState {
  coveredFromMs: number;
  coveredToMs: number;
  refreshedAtMs: number;
  records: UsageRecord[];
}

export interface CursorFetchSpan {
  startMs: number;
  endMs: number;
}

export interface PlanCursorFetchesOptions {
  cache: CursorCacheState | null;
  windowStartMs: number;
  nowMs: number;
  ttlMs: number;
  overlapMs: number;
}

/**
 * Billed events never change once a day closes, so only the uncovered head of
 * the window and a short trailing overlap are ever re-requested.
 */
export function planCursorFetches(
  options: PlanCursorFetchesOptions,
): CursorFetchSpan[] {
  const { cache, windowStartMs, nowMs, ttlMs, overlapMs } = options;

  if (cache === null || cache.coveredToMs <= cache.coveredFromMs) {
    return [{ startMs: windowStartMs, endMs: nowMs }];
  }

  const spans: CursorFetchSpan[] = [];

  if (windowStartMs < cache.coveredFromMs) {
    spans.push({ startMs: windowStartMs, endMs: cache.coveredFromMs });
  }

  if (nowMs - cache.refreshedAtMs >= ttlMs) {
    const startMs = Math.max(
      windowStartMs,
      Math.min(cache.coveredToMs - overlapMs, nowMs),
    );
    if (startMs < nowMs) {
      spans.push({ startMs, endMs: nowMs });
    }
  }

  return spans;
}

export function mergeCursorRecords(
  existing: readonly UsageRecord[],
  incoming: readonly UsageRecord[],
): UsageRecord[] {
  const byKey = new Map<string, UsageRecord>();
  for (const record of [...existing, ...incoming]) {
    byKey.set(record.dedupeKey ?? `${record.timestampMs}`, record);
  }
  return [...byKey.values()].sort((a, b) => a.timestampMs - b.timestampMs);
}

export function pruneCursorRecords(
  records: readonly UsageRecord[],
  cutoffMs: number,
): UsageRecord[] {
  return records.filter((record) => record.timestampMs >= cutoffMs);
}

type SerializedRow = [
  timestampMs: number,
  modelIndex: number,
  sessionIndex: number,
  uncachedInputTokens: number,
  cachedInputTokens: number,
  cacheCreationTokens: number,
  outputTokens: number,
  costUsd: number,
];

interface SerializedCursorCache {
  version: number;
  coveredFromMs: number;
  coveredToMs: number;
  refreshedAtMs: number;
  models: string[];
  sessions: string[];
  rows: SerializedRow[];
}

export function encodeCursorCache(
  state: CursorCacheState,
): SerializedCursorCache {
  const models: string[] = [];
  const sessions: string[] = [];
  const modelIndex = new Map<string, number>();
  const sessionIndex = new Map<string, number>();

  const intern = (
    table: string[],
    index: Map<string, number>,
    value: string,
  ): number => {
    const existing = index.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const next = table.length;
    table.push(value);
    index.set(value, next);
    return next;
  };

  return {
    version: CURSOR_CACHE_VERSION,
    coveredFromMs: state.coveredFromMs,
    coveredToMs: state.coveredToMs,
    refreshedAtMs: state.refreshedAtMs,
    models,
    sessions,
    rows: state.records.map((record) => [
      record.timestampMs,
      intern(models, modelIndex, record.model),
      intern(sessions, sessionIndex, record.sessionId),
      record.totals.uncachedInputTokens,
      record.totals.cachedInputTokens,
      record.totals.cacheCreationTokens,
      record.totals.outputTokens,
      record.costUsd ?? 0,
    ]),
  };
}

function allStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function decodeCursorCache(document: unknown): CursorCacheState | null {
  if (typeof document !== "object" || document === null) {
    return null;
  }

  const root = document as Partial<SerializedCursorCache>;
  if (root.version !== CURSOR_CACHE_VERSION) {
    return null;
  }
  if (
    !finite(root.coveredFromMs) ||
    !finite(root.coveredToMs) ||
    !finite(root.refreshedAtMs)
  ) {
    return null;
  }
  if (!allStrings(root.models) || !allStrings(root.sessions)) {
    return null;
  }
  if (!Array.isArray(root.rows)) {
    return null;
  }
  const models = root.models;
  const sessions = root.sessions;

  const records: UsageRecord[] = [];
  for (const row of root.rows) {
    if (!Array.isArray(row) || row.length < 8) {
      return null;
    }
    const [
      timestampMs,
      modelIndex,
      sessionIndex,
      uncached,
      cached,
      cacheCreation,
      output,
      costUsd,
    ] = row as SerializedRow;

    const model = finite(modelIndex) ? models[modelIndex] : undefined;
    const sessionId = finite(sessionIndex) ? sessions[sessionIndex] : undefined;
    if (
      !finite(timestampMs) ||
      model === undefined ||
      sessionId === undefined ||
      !finite(uncached) ||
      !finite(cached) ||
      !finite(cacheCreation) ||
      !finite(output) ||
      !finite(costUsd)
    ) {
      return null;
    }

    records.push({
      provider: "cursor",
      timestampMs,
      model,
      sessionId,
      totals: {
        uncachedInputTokens: uncached,
        cachedInputTokens: cached,
        cacheCreationTokens: cacheCreation,
        outputTokens: output,
        reasoningTokens: 0,
      },
      dedupeKey: cursorDedupeKey(timestampMs, sessionId, model, costUsd),
      costUsd,
    });
  }

  return {
    coveredFromMs: root.coveredFromMs,
    coveredToMs: root.coveredToMs,
    refreshedAtMs: root.refreshedAtMs,
    records,
  };
}
