import {
  buildDayColumns,
  niceScale,
} from "@renderer/components/usage-history-chart";
import type { UsageDayTotals } from "@renderer/lib/usage-history-view";
import { describe, expect, it } from "vitest";

describe("niceScale", () => {
  it("rounds the maximum up so the peak is never clipped", () => {
    const { max, ticks } = niceScale(37, 4);
    expect(max).toBeGreaterThanOrEqual(37);
    expect(ticks[0]).toBe(0);
    expect(ticks.at(-1)).toBe(max);
  });

  it("uses a 1/2/5 x 10^n step", () => {
    expect(niceScale(100, 4).ticks).toEqual([0, 50, 100]);
    expect(niceScale(8, 4).ticks).toEqual([0, 2, 4, 6, 8]);
    expect(niceScale(400, 4).ticks).toEqual([0, 100, 200, 300, 400]);
    expect(
      niceScale(0.08, 4).ticks.map((tick) => Number(tick.toFixed(2))),
    ).toEqual([0, 0.02, 0.04, 0.06, 0.08]);
  });

  it("collapses to a single tick with nothing to plot", () => {
    expect(niceScale(0, 4)).toEqual({ max: 0, ticks: [0] });
    expect(niceScale(-5, 4)).toEqual({ max: 0, ticks: [0] });
  });
});

function day(
  dayString: string,
  byProvider: Record<string, { costUsd: number; totalTokens: number }>,
): UsageDayTotals {
  const entries = Object.entries(byProvider);
  return {
    day: dayString,
    costUsd: entries.reduce((sum, [, value]) => sum + value.costUsd, 0),
    totalTokens: entries.reduce((sum, [, value]) => sum + value.totalTokens, 0),
    byProvider: new Map(entries) as UsageDayTotals["byProvider"],
  };
}

describe("buildDayColumns", () => {
  it("emits one band per provider for every day, filling gaps with zero", () => {
    const byDay = new Map([
      [
        "2026-09-08",
        day("2026-09-08", { claude: { costUsd: 2, totalTokens: 20 } }),
      ],
    ]);

    const columns = buildDayColumns(
      ["2026-09-08", "2026-09-09"],
      byDay,
      ["claude", "codex"],
      "cost",
    );

    expect(columns).toEqual([
      {
        bands: [
          { provider: "claude", value: 2 },
          { provider: "codex", value: 0 },
        ],
        total: 2,
      },
      {
        bands: [
          { provider: "claude", value: 0 },
          { provider: "codex", value: 0 },
        ],
        total: 0,
      },
    ]);
  });

  it("reads the token metric when asked", () => {
    const byDay = new Map([
      [
        "2026-09-08",
        day("2026-09-08", { claude: { costUsd: 2, totalTokens: 20 } }),
      ],
    ]);
    expect(
      buildDayColumns(["2026-09-08"], byDay, ["claude"], "tokens")[0]?.total,
    ).toBe(20);
  });
});
