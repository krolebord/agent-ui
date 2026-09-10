import {
  bucketValue,
  deriveUsageHistoryView,
  makeUsageWindow,
  sortModelsForMetric,
} from "@renderer/lib/usage-history-view";
import type { UsageHistorySummary } from "@shared/usage-history";
import { afterEach, describe, expect, it } from "vitest";

const originalTimeZone = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTimeZone;
});

describe("makeUsageWindow", () => {
  it("spans the requested number of calendar days inclusively", () => {
    process.env.TZ = "UTC";
    expect(makeUsageWindow(7, new Date("2026-09-09T12:00:00Z"))).toEqual({
      sinceDay: "2026-09-03",
      untilDay: "2026-09-09",
      timeZone: "UTC",
    });
    expect(makeUsageWindow(1, new Date("2026-09-09T12:00:00Z")).sinceDay).toBe(
      "2026-09-09",
    );
  });

  it("uses the viewer's own day boundary, not UTC's", () => {
    process.env.TZ = "America/Los_Angeles";
    expect(makeUsageWindow(7, new Date("2026-09-10T04:30:00Z")).untilDay).toBe(
      "2026-09-09",
    );
  });

  it("keeps the calendar span exact across a spring-forward transition", () => {
    process.env.TZ = "America/Los_Angeles";
    expect(makeUsageWindow(7, new Date("2026-03-10T07:30:00Z"))).toEqual({
      sinceDay: "2026-03-04",
      untilDay: "2026-03-10",
      timeZone: "America/Los_Angeles",
    });
  });

  it("keeps the calendar span exact across a fall-back transition", () => {
    process.env.TZ = "America/Los_Angeles";
    expect(makeUsageWindow(7, new Date("2026-11-03T07:30:00Z"))).toEqual({
      sinceDay: "2026-10-27",
      untilDay: "2026-11-02",
      timeZone: "America/Los_Angeles",
    });
  });

  it("crosses a month boundary", () => {
    process.env.TZ = "UTC";
    expect(makeUsageWindow(30, new Date("2026-09-09T12:00:00Z")).sinceDay).toBe(
      "2026-08-11",
    );
  });
});

function summary(
  overrides: Partial<UsageHistorySummary> = {},
): UsageHistorySummary {
  return {
    readAt: "2026-09-09T12:00:00.000Z",
    timeZone: "UTC",
    sinceDay: "2026-09-08",
    untilDay: "2026-09-09",
    buckets: [],
    sources: [],
    pricing: { status: "fresh", fetchedAt: null, knownModels: 1 },
    scanDurationMs: 1,
    ...overrides,
  };
}

function bucket(
  overrides: Partial<UsageHistorySummary["buckets"][number]> = {},
): UsageHistorySummary["buckets"][number] {
  return {
    day: "2026-09-09",
    provider: "claude",
    model: "claude-opus-5",
    totals: {
      uncachedInputTokens: 10,
      cachedInputTokens: 20,
      cacheCreationTokens: 5,
      outputTokens: 4,
      reasoningTokens: 2,
    },
    costUsd: 1,
    cacheSavingsUsd: 0.5,
    costSource: "modelPriced",
    records: 1,
    unpricedRecords: 0,
    sessions: 1,
    ...overrides,
  };
}

describe("deriveUsageHistoryView", () => {
  it("returns empty totals with no summary", () => {
    const view = deriveUsageHistoryView(undefined);
    expect(view.totalTokens).toBe(0);
    expect(view.activeProviders).toEqual([]);
  });

  it("totals tokens without adding reasoning on top of output", () => {
    const view = deriveUsageHistoryView(summary({ buckets: [bucket()] }));
    expect(view.totalTokens).toBe(39);
    expect(view.outputTokens).toBe(4);
  });

  it("takes sessions from the sources, not from the buckets", () => {
    const view = deriveUsageHistoryView(
      summary({
        buckets: [bucket(), bucket({ day: "2026-09-08" })],
        sources: [
          {
            provider: "claude",
            kind: "transcripts",
            origin: "/tmp/claude",
            status: "ok",
            scannedFiles: 1,
            skippedFiles: 0,
            distinctSessions: 1,
            message: null,
          },
        ],
      }),
    );
    expect(view.sessions).toBe(1);
    expect(view.providers[0]?.sessions).toBe(1);
  });

  it("splits totals by provider, model and day and computes shares", () => {
    const view = deriveUsageHistoryView(
      summary({
        buckets: [
          bucket({ costUsd: 3 }),
          bucket({ provider: "codex", model: "gpt-5.6-sol", costUsd: 1 }),
        ],
      }),
    );

    expect(view.costUsd).toBe(4);
    expect(view.activeProviders).toEqual(["claude", "codex"]);
    expect(view.providers.map((entry) => entry.costShare)).toEqual([
      0.75, 0.25,
    ]);
    expect(view.models.map((entry) => entry.model)).toEqual([
      "claude-opus-5",
      "gpt-5.6-sol",
    ]);
    expect(view.daily).toHaveLength(1);
    expect(view.daily[0]?.byProvider.get("codex")?.costUsd).toBe(1);
  });

  it("orders days oldest first", () => {
    const view = deriveUsageHistoryView(
      summary({
        buckets: [bucket(), bucket({ day: "2026-09-08" })],
      }),
    );
    expect(view.daily.map((entry) => entry.day)).toEqual([
      "2026-09-08",
      "2026-09-09",
    ]);
  });
});

describe("sortModelsForMetric", () => {
  const models = [
    {
      provider: "claude" as const,
      model: "expensive",
      costUsd: 10,
      totalTokens: 1,
      costShare: 1,
      tokenShare: 0,
    },
    {
      provider: "codex" as const,
      model: "chatty",
      costUsd: 1,
      totalTokens: 100,
      costShare: 0,
      tokenShare: 1,
    },
  ];

  it("keeps the cost order untouched in cost mode", () => {
    expect(sortModelsForMetric(models, "cost")).toBe(models);
  });

  it("re-sorts by tokens in token mode", () => {
    expect(
      sortModelsForMetric(models, "tokens").map((entry) => entry.model),
    ).toEqual(["chatty", "expensive"]);
  });
});

describe("bucketValue", () => {
  it("reads whichever metric is on screen and treats a gap as zero", () => {
    const pair = { costUsd: 2, totalTokens: 7 };
    expect(bucketValue(pair, "cost")).toBe(2);
    expect(bucketValue(pair, "tokens")).toBe(7);
    expect(bucketValue(undefined, "cost")).toBe(0);
  });
});
