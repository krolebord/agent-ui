import { describe, expect, it } from "vitest";
import {
  type CursorCacheState,
  decodeCursorCache,
  encodeCursorCache,
  mergeCursorRecords,
  planCursorFetches,
  pruneCursorRecords,
} from "../../../src/main/usage-history/cursor-cache";
import { cursorDedupeKey } from "../../../src/main/usage-history/cursor-events";
import type { UsageRecord } from "../../../src/main/usage-history/transcripts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function record(timestampMs: number, costUsd = 0.5): UsageRecord {
  return {
    provider: "cursor",
    timestampMs,
    model: "composer-2.5",
    sessionId: "conv-1",
    totals: {
      uncachedInputTokens: 1,
      cachedInputTokens: 2,
      cacheCreationTokens: 3,
      outputTokens: 4,
      reasoningTokens: 0,
    },
    dedupeKey: cursorDedupeKey(timestampMs, "conv-1", "composer-2.5", costUsd),
    costUsd,
  };
}

function state(overrides: Partial<CursorCacheState> = {}): CursorCacheState {
  return {
    coveredFromMs: 1_000_000,
    coveredToMs: 2_000_000,
    refreshedAtMs: 2_000_000,
    records: [record(1_500_000)],
    ...overrides,
  };
}

describe("planCursorFetches", () => {
  const base = { ttlMs: MINUTE, overlapMs: 5 * MINUTE };

  it("fetches the whole window when nothing is cached", () => {
    expect(
      planCursorFetches({
        ...base,
        cache: null,
        windowStartMs: 100,
        nowMs: 900,
      }),
    ).toEqual([{ startMs: 100, endMs: 900 }]);
  });

  it("asks for nothing while the trailing edge is still fresh", () => {
    const cache = state({ coveredToMs: 2_000_000, refreshedAtMs: 2_000_000 });
    expect(
      planCursorFetches({
        ...base,
        cache,
        windowStartMs: cache.coveredFromMs + 1,
        nowMs: 2_000_000 + 30_000,
      }),
    ).toEqual([]);
  });

  it("refreshes only the trailing overlap once the ttl lapses", () => {
    const cache = state({ coveredToMs: 2_000_000, refreshedAtMs: 2_000_000 });
    const nowMs = 2_000_000 + 2 * MINUTE;
    expect(
      planCursorFetches({
        ...base,
        cache,
        windowStartMs: cache.coveredFromMs + 1,
        nowMs,
      }),
    ).toEqual([{ startMs: 2_000_000 - 5 * MINUTE, endMs: nowMs }]);
  });

  it("backfills only the span older than the cache", () => {
    const cache = state({ refreshedAtMs: 2_000_000 });
    const spans = planCursorFetches({
      ...base,
      cache,
      windowStartMs: 500_000,
      nowMs: 2_000_000 + 30_000,
    });
    expect(spans).toEqual([{ startMs: 500_000, endMs: 1_000_000 }]);
  });

  it("never reaches back before the requested window", () => {
    const cache = state({ coveredToMs: 2_000_000, refreshedAtMs: 0 });
    const nowMs = 2_000_000;
    const spans = planCursorFetches({
      ...base,
      cache,
      windowStartMs: 1_999_000,
      nowMs,
    });
    expect(spans).toEqual([{ startMs: 1_999_000, endMs: nowMs }]);
  });
});

describe("mergeCursorRecords", () => {
  it("drops a re-fetched duplicate and keeps the order by time", () => {
    const merged = mergeCursorRecords(
      [record(3_000), record(1_000)],
      [record(1_000), record(2_000)],
    );
    expect(merged.map((entry) => entry.timestampMs)).toEqual([
      1_000, 2_000, 3_000,
    ]);
  });

  it("keeps two events that differ only by cost", () => {
    const merged = mergeCursorRecords(
      [record(1_000, 0.5)],
      [record(1_000, 0.9)],
    );
    expect(merged).toHaveLength(2);
  });
});

describe("pruneCursorRecords", () => {
  it("drops everything older than the cutoff", () => {
    const kept = pruneCursorRecords(
      [record(1_000), record(5_000), record(9_000)],
      5_000,
    );
    expect(kept.map((entry) => entry.timestampMs)).toEqual([5_000, 9_000]);
  });
});

describe("cursor cache round trip", () => {
  it("restores the covered span and every record", () => {
    const original = state({
      records: [record(1_200_000, 0.25), record(1_800_000, 1.5)],
    });
    const decoded = decodeCursorCache(
      JSON.parse(JSON.stringify(encodeCursorCache(original))),
    );
    expect(decoded).toEqual(original);
  });

  it("interns repeated models and sessions", () => {
    const encoded = encodeCursorCache(
      state({ records: [record(1), record(2)] }),
    );
    expect(encoded.models).toEqual(["composer-2.5"]);
    expect(encoded.sessions).toEqual(["conv-1"]);
  });

  it("refuses a corrupt or stale document", () => {
    expect(decodeCursorCache(null)).toBeNull();
    expect(decodeCursorCache({ version: 999 })).toBeNull();
    const encoded = encodeCursorCache(state());
    expect(decodeCursorCache({ ...encoded, rows: [[1, 0]] })).toBeNull();
    expect(decodeCursorCache({ ...encoded, coveredFromMs: "nope" })).toBeNull();
  });

  it("survives a full day of records", () => {
    const records = Array.from({ length: 200 }, (_, index) =>
      record(1_000_000 + index * DAY),
    );
    const decoded = decodeCursorCache(
      JSON.parse(JSON.stringify(encodeCursorCache(state({ records })))),
    );
    expect(decoded?.records).toHaveLength(200);
  });
});
