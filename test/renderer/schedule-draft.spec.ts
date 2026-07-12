import { describe, expect, it } from "vitest";
import {
  buildScheduleSpec,
  scheduleSpecToDraft,
} from "../../src/renderer/src/lib/schedule-draft";

describe("scheduleSpecToDraft", () => {
  it("maps one-time schedules to a datetime-local value", () => {
    const at = new Date(2026, 6, 12, 9, 30).getTime();
    expect(scheduleSpecToDraft({ kind: "once", at })).toEqual({
      kind: "once",
      at: "2026-07-12T09:30",
    });
  });

  it.each([
    ["30 * * * *", "hourly", "00:30", "1"],
    ["0 9 * * *", "daily", "09:00", "1"],
    ["15 18 * * 1-5", "weekdays", "18:15", "1"],
    ["0 7 * * 3", "weekly", "07:00", "3"],
  ])("maps cron %s to the %s preset", (cron, preset, time, weekday) => {
    expect(scheduleSpecToDraft({ kind: "recurring", cron })).toEqual({
      kind: "recurring",
      preset,
      time,
      weekday,
      cron,
    });
  });

  it("falls back to the custom preset for other cron expressions", () => {
    const draft = scheduleSpecToDraft({
      kind: "recurring",
      cron: "*/10 9-17 * * *",
    });
    expect(draft).toMatchObject({
      kind: "recurring",
      preset: "custom",
      cron: "*/10 9-17 * * *",
    });
  });

  it.each([
    "30 * * * *",
    "0 9 * * *",
    "15 18 * * 1-5",
    "0 7 * * 3",
  ])("round-trips cron %s through buildScheduleSpec", (cron) => {
    const draft = scheduleSpecToDraft({ kind: "recurring", cron });
    expect(buildScheduleSpec(draft)).toEqual({
      schedule: { kind: "recurring", cron },
    });
  });
});
