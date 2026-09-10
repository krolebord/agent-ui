import {
  enumerateDays,
  formatCount,
  formatDayShort,
  formatPercent,
  formatTokens,
  formatUsd,
} from "@renderer/lib/usage-history-format";
import { describe, expect, it } from "vitest";

describe("formatUsd", () => {
  it("always shows two decimal places", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(0.004)).toBe("$0.00");
  });
});

describe("formatTokens", () => {
  it("compacts to three significant figures with a unit suffix", () => {
    expect(formatTokens(19_900_000_000)).toBe("19.9B");
    expect(formatTokens(76_700_000)).toBe("76.7M");
    expect(formatTokens(804_000)).toBe("804K");
    expect(formatTokens(1_234_000_000_000)).toBe("1.23T");
  });

  it("drops a wholly zero fraction", () => {
    expect(formatTokens(2_000)).toBe("2K");
    expect(formatTokens(1_500_000)).toBe("1.50M");
  });

  it("prints small counts in full", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });
});

describe("formatCount", () => {
  it("groups thousands", () => {
    expect(formatCount(1234)).toBe("1,234");
  });
});

describe("formatPercent", () => {
  it("renders a share to one decimal by default", () => {
    expect(formatPercent(0.412)).toBe("41.2%");
    expect(formatPercent(0.412, 0)).toBe("41%");
  });
});

describe("formatDayShort", () => {
  it("renders a month name and day of month", () => {
    expect(formatDayShort("2026-08-07")).toBe("Aug 7");
    expect(formatDayShort("2026-12-31")).toBe("Dec 31");
  });

  it("returns the input unchanged when it is not a day", () => {
    expect(formatDayShort("nonsense")).toBe("nonsense");
    expect(formatDayShort("2026-13-01")).toBe("2026-13-01");
  });
});

describe("enumerateDays", () => {
  it("lists both bounds inclusively", () => {
    expect(enumerateDays("2026-09-07", "2026-09-10")).toEqual([
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
    ]);
  });

  it("crosses a month boundary", () => {
    expect(enumerateDays("2026-08-31", "2026-09-01")).toEqual([
      "2026-08-31",
      "2026-09-01",
    ]);
  });

  it("returns nothing for a reversed or unparseable range", () => {
    expect(enumerateDays("2026-09-10", "2026-09-07")).toEqual([]);
    expect(enumerateDays("nope", "2026-09-07")).toEqual([]);
  });
});
