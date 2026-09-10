import {
  addUsageTotals,
  totalUsageTokens,
  usageHistorySummaryInputSchema,
} from "@shared/usage-history";
import { describe, expect, it } from "vitest";

const TOTALS = {
  uncachedInputTokens: 100,
  cachedInputTokens: 200,
  cacheCreationTokens: 30,
  outputTokens: 40,
  reasoningTokens: 25,
};

describe("totalUsageTokens", () => {
  it("never adds reasoning on top of output", () => {
    expect(totalUsageTokens(TOTALS)).toBe(370);
    expect(totalUsageTokens({ ...TOTALS, reasoningTokens: 40 })).toBe(370);
    expect(totalUsageTokens({ ...TOTALS, reasoningTokens: 0 })).toBe(370);
  });
});

describe("addUsageTotals", () => {
  it("sums every class including reasoning", () => {
    expect(addUsageTotals(TOTALS, TOTALS)).toEqual({
      uncachedInputTokens: 200,
      cachedInputTokens: 400,
      cacheCreationTokens: 60,
      outputTokens: 80,
      reasoningTokens: 50,
    });
  });
});

describe("usageHistorySummaryInputSchema", () => {
  const valid = {
    sinceDay: "2026-08-11",
    untilDay: "2026-09-09",
    timeZone: "America/Los_Angeles",
  };

  it("accepts a well-formed window", () => {
    expect(usageHistorySummaryInputSchema.parse(valid)).toEqual(valid);
  });

  it("rejects a day that is shaped right but is not a date", () => {
    expect(
      usageHistorySummaryInputSchema.safeParse({
        ...valid,
        sinceDay: "2026-13-45",
      }).success,
    ).toBe(false);
  });

  it("rejects a reversed window", () => {
    expect(
      usageHistorySummaryInputSchema.safeParse({
        ...valid,
        sinceDay: "2026-09-10",
      }).success,
    ).toBe(false);
  });
});
