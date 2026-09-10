import { describe, expect, it } from "vitest";
import { UsageHistoryAggregator } from "../../../src/main/usage-history/aggregation";
import { parseRateTable } from "../../../src/main/usage-history/pricing";
import type { UsageRecord } from "../../../src/main/usage-history/transcripts";

const RATES = parseRateTable({
  "claude-opus-5": {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 2.5e-5,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 6.25e-6,
  },
});

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    timestampMs: Date.parse("2026-09-09T12:00:00.000Z"),
    model: "claude-opus-5",
    sessionId: "session-1",
    totals: {
      uncachedInputTokens: 10,
      cachedInputTokens: 20,
      cacheCreationTokens: 5,
      outputTokens: 4,
      reasoningTokens: 2,
    },
    dedupeKey: null,
    costUsd: null,
    ...overrides,
  };
}

function aggregate(
  records: UsageRecord[],
  options: { timeZone?: string; sinceDay?: string; untilDay?: string } = {},
) {
  const aggregator = new UsageHistoryAggregator({
    timeZone: options.timeZone ?? "UTC",
    sinceDay: options.sinceDay ?? "2026-09-01",
    untilDay: options.untilDay ?? "2026-09-30",
    rates: RATES,
  });
  const accepted = records.map((entry) => aggregator.add(entry));
  return { ...aggregator.finish(), accepted };
}

describe("UsageHistoryAggregator", () => {
  it("counts a repeated dedupe key once", () => {
    const result = aggregate([
      record({ dedupeKey: "msg_1:req_1" }),
      record({ dedupeKey: "msg_1:req_1" }),
      record({ dedupeKey: "msg_2:req_1" }),
    ]);

    expect(result.duplicatesDropped).toBe(1);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]?.records).toBe(2);
    expect(result.buckets[0]?.totals.outputTokens).toBe(8);
  });

  it("buckets the same instant on different days per time zone", () => {
    const instant = record({
      timestampMs: Date.parse("2026-09-10T04:30:00.000Z"),
    });

    expect(aggregate([instant], { timeZone: "UTC" }).buckets[0]?.day).toBe(
      "2026-09-10",
    );
    expect(
      aggregate([instant], { timeZone: "America/Los_Angeles" }).buckets[0]?.day,
    ).toBe("2026-09-09");
  });

  it("degrades an unknown zone to UTC rather than failing the scan", () => {
    expect(
      aggregate([record()], { timeZone: "Mars/Olympus" }).buckets[0]?.day,
    ).toBe("2026-09-09");
  });

  it("drops records outside the window", () => {
    const result = aggregate(
      [
        record({ timestampMs: Date.parse("2026-08-31T23:00:00.000Z") }),
        record(),
        record({ timestampMs: Date.parse("2026-10-01T01:00:00.000Z") }),
      ],
      { sinceDay: "2026-09-01", untilDay: "2026-09-30" },
    );

    expect(result.outOfWindow).toBe(2);
    expect(result.accepted).toEqual([false, true, false]);
    expect(result.buckets).toHaveLength(1);
  });

  it("counts distinct sessions per cell", () => {
    const result = aggregate([
      record({ sessionId: "a" }),
      record({ sessionId: "a" }),
      record({ sessionId: "b" }),
      record({ sessionId: "" }),
    ]);
    expect(result.buckets[0]?.sessions).toBe(2);
  });

  it("splits cells by day, provider and model and sorts them", () => {
    const result = aggregate([
      record({ provider: "codex", model: "gpt-5.6-sol" }),
      record({ model: "claude-sonnet-5" }),
      record({ timestampMs: Date.parse("2026-09-08T12:00:00.000Z") }),
    ]);

    expect(
      result.buckets.map((bucket) => [
        bucket.day,
        bucket.provider,
        bucket.model,
      ]),
    ).toEqual([
      ["2026-09-08", "claude", "claude-opus-5"],
      ["2026-09-09", "claude", "claude-sonnet-5"],
      ["2026-09-09", "codex", "gpt-5.6-sol"],
    ]);
  });

  it("prices priced records and marks a wholly unpriced cell", () => {
    const priced = aggregate([record()]).buckets[0];
    expect(priced?.costSource).toBe("modelPriced");
    expect(priced?.costUsd).toBeCloseTo(
      10 * 5e-6 + 20 * 5e-7 + 5 * 6.25e-6 + 4 * 2.5e-5,
      12,
    );
    expect(priced?.cacheSavingsUsd).toBeCloseTo(20 * (5e-6 - 5e-7), 12);

    const unpriced = aggregate([record({ model: "<synthetic>" })]).buckets[0];
    expect(unpriced?.costSource).toBe("unpriced");
    expect(unpriced?.costUsd).toBe(0);
    expect(unpriced?.unpricedRecords).toBe(1);
    expect(unpriced?.totals.outputTokens).toBe(4);
  });
});
