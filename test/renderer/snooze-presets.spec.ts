import { describe, expect, it } from "vitest";
import {
  resolveSnoozePresets,
  snoozeWakeDescription,
  snoozeWakeLabel,
} from "../../src/renderer/src/lib/snooze-presets";

function at(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

const HOUR_MS = 60 * 60 * 1_000;

describe("resolveSnoozePresets", () => {
  const wednesdayMorning = at(2026, 8, 5, 10);

  it("offers all four presets in the morning", () => {
    expect(
      resolveSnoozePresets(wednesdayMorning).map((preset) => preset.id),
    ).toEqual(["hour", "evening", "tomorrow", "next-week"]);
  });

  it("resolves each preset to a local wall-clock time", () => {
    const presets = resolveSnoozePresets(wednesdayMorning);
    const byId = new Map(presets.map((preset) => [preset.id, preset]));

    expect(byId.get("hour")?.snoozedUntil).toBe(wednesdayMorning + HOUR_MS);
    expect(byId.get("evening")?.snoozedUntil).toBe(at(2026, 8, 5, 18));
    expect(byId.get("tomorrow")?.snoozedUntil).toBe(at(2026, 8, 6, 9));
    expect(byId.get("next-week")?.snoozedUntil).toBe(at(2026, 8, 10, 9));
  });

  it("drops the evening preset once evening is within the hour", () => {
    for (const now of [at(2026, 8, 5, 17, 30), at(2026, 8, 5, 21)]) {
      expect(resolveSnoozePresets(now).map((preset) => preset.id)).toEqual([
        "hour",
        "tomorrow",
        "next-week",
      ]);
    }
  });

  it("puts next week a full week out when today is Monday", () => {
    const monday = at(2026, 8, 10, 10);
    const presets = resolveSnoozePresets(monday);
    const nextWeek = presets.find((preset) => preset.id === "next-week");

    expect(nextWeek?.snoozedUntil).toBe(at(2026, 8, 17, 9));
  });

  it("never resolves a preset into the past", () => {
    const lateNight = at(2026, 8, 5, 23, 30);
    for (const preset of resolveSnoozePresets(lateNight)) {
      expect(preset.snoozedUntil).toBeGreaterThan(lateNight);
    }
  });

  it("advances by calendar day, so a DST shift cannot skip a day", () => {
    const beforeSpringForward = at(2026, 3, 7, 23, 30);
    const tomorrow = resolveSnoozePresets(beforeSpringForward).find(
      (preset) => preset.id === "tomorrow",
    );

    expect(new Date(tomorrow?.snoozedUntil ?? 0).getDate()).toBe(8);
  });
});

describe("snoozeWakeLabel", () => {
  const now = at(2026, 8, 5, 10);

  it("reads as a countdown, not an age", () => {
    expect(snoozeWakeLabel(now + 2 * HOUR_MS, now)).toBe("in 2h");
  });

  it("rounds minutes up so a hidden row never claims to wake in 0m", () => {
    expect(snoozeWakeLabel(now + 30_000, now)).toBe("in 1m");
    expect(snoozeWakeLabel(now + 90_000, now)).toBe("in 2m");
  });

  it("steps up to hours and days", () => {
    expect(snoozeWakeLabel(now + 23 * HOUR_MS, now)).toBe("in 23h");
    expect(snoozeWakeLabel(now + 25 * HOUR_MS, now)).toBe("in 2d");
  });

  it("reads 'now' once the wake time has passed", () => {
    expect(snoozeWakeLabel(now, now)).toBe("now");
    expect(snoozeWakeLabel(now - HOUR_MS, now)).toBe("now");
  });
});

describe("snoozeWakeDescription", () => {
  const now = at(2026, 8, 5, 10);

  it("names the day only when it is not today", () => {
    expect(snoozeWakeDescription(at(2026, 8, 5, 18), now)).not.toContain(
      "tomorrow",
    );
    expect(snoozeWakeDescription(at(2026, 8, 6, 9), now)).toContain("tomorrow");
  });

  it("uses a weekday inside the week and a date beyond it", () => {
    expect(snoozeWakeDescription(at(2026, 8, 7, 9), now)).toContain("Fri");
    expect(snoozeWakeDescription(at(2026, 8, 21, 9), now)).toContain("Aug");
  });
});
