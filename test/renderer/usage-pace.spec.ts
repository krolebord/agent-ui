import { describe, expect, it } from "vitest";
import {
  computeUsagePace,
  computeUsagePaceBetween,
  formatUsagePaceDelta,
  parseEpochMillis,
} from "../../src/renderer/src/lib/usage-pace";

const WEEK_SECONDS = 7 * 24 * 60 * 60;
const RESET_AT = "2026-08-21T00:00:00.000Z";
const RESET_MS = Date.parse(RESET_AT);
const WINDOW_START_MS = RESET_MS - WEEK_SECONDS * 1_000;

function nowAtElapsed(elapsedPercent: number): number {
  return WINDOW_START_MS + (WEEK_SECONDS * 1_000 * elapsedPercent) / 100;
}

describe("computeUsagePace", () => {
  it("shows +15% reserve when 35% is used halfway through the week", () => {
    const pace = computeUsagePace({
      usedPercent: 35,
      windowSeconds: WEEK_SECONDS,
      resetsAt: RESET_AT,
      now: nowAtElapsed(50),
    });

    expect(pace).toMatchObject({ elapsedPercent: 50, deltaPercent: 15 });
    expect(formatUsagePaceDelta(pace?.deltaPercent ?? 0)).toBe("+15%");
  });

  it("shows -15% deficit when 50% is used 35% through the week", () => {
    const pace = computeUsagePace({
      usedPercent: 50,
      windowSeconds: WEEK_SECONDS,
      resetsAt: RESET_AT,
      now: nowAtElapsed(35),
    });

    expect(pace).toMatchObject({ elapsedPercent: 35, deltaPercent: -15 });
    expect(formatUsagePaceDelta(pace?.deltaPercent ?? 0)).toBe("-15%");
  });

  it("hides pace before 3% of the window has elapsed", () => {
    expect(
      computeUsagePace({
        usedPercent: 1,
        windowSeconds: WEEK_SECONDS,
        resetsAt: RESET_AT,
        now: nowAtElapsed(2),
      }),
    ).toBeNull();
  });

  it("hides pace once the window has elapsed", () => {
    expect(
      computeUsagePace({
        usedPercent: 80,
        windowSeconds: WEEK_SECONDS,
        resetsAt: RESET_AT,
        now: RESET_MS,
      }),
    ).toBeNull();
  });

  it("returns null without a reset time or duration", () => {
    expect(
      computeUsagePace({
        usedPercent: 35,
        windowSeconds: WEEK_SECONDS,
        resetsAt: null,
        now: nowAtElapsed(50),
      }),
    ).toBeNull();
    expect(
      computeUsagePace({
        usedPercent: 35,
        windowSeconds: 0,
        resetsAt: RESET_AT,
        now: nowAtElapsed(50),
      }),
    ).toBeNull();
  });
});

describe("computeUsagePaceBetween", () => {
  const startMs = Date.parse("2026-08-01T00:00:00.000Z");
  const endMs = Date.parse("2026-09-01T00:00:00.000Z");
  const monthMs = endMs - startMs;

  function nowAtElapsed(elapsedPercent: number): number {
    return startMs + (monthMs * elapsedPercent) / 100;
  }

  it("shows +15% reserve when 35% of a monthly plan is used halfway through", () => {
    const pace = computeUsagePaceBetween({
      usedPercent: 35,
      startMs,
      endMs,
      now: nowAtElapsed(50),
    });

    expect(pace).toMatchObject({ elapsedPercent: 50, deltaPercent: 15 });
    expect(formatUsagePaceDelta(pace?.deltaPercent ?? 0)).toBe("+15%");
  });

  it("shows -15% deficit when 50% of a monthly plan is used 35% through", () => {
    const pace = computeUsagePaceBetween({
      usedPercent: 50,
      startMs,
      endMs,
      now: nowAtElapsed(35),
    });

    expect(pace).toMatchObject({ elapsedPercent: 35, deltaPercent: -15 });
    expect(formatUsagePaceDelta(pace?.deltaPercent ?? 0)).toBe("-15%");
  });

  it("returns null when the cycle range is invalid", () => {
    expect(
      computeUsagePaceBetween({
        usedPercent: 35,
        startMs: endMs,
        endMs: startMs,
        now: nowAtElapsed(50),
      }),
    ).toBeNull();
  });
});

describe("parseEpochMillis", () => {
  it("parses Cursor millisecond epoch strings", () => {
    expect(parseEpochMillis("1782977854000")).toBe(1_782_977_854_000);
  });

  it("promotes second-precision epochs to milliseconds", () => {
    expect(parseEpochMillis("1782977854")).toBe(1_782_977_854_000);
  });

  it("returns null for missing values", () => {
    expect(parseEpochMillis(null)).toBeNull();
    expect(parseEpochMillis("")).toBeNull();
  });
});
