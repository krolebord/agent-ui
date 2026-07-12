import type { ScheduleSpec } from "@main/scheduled-sessions/state";
import { Cron } from "croner";

export type RecurringPreset =
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "custom";

export type ScheduleDraft =
  | { kind: "once"; at: string }
  | {
      kind: "recurring";
      preset: RecurringPreset;
      time: string;
      weekday: string;
      cron: string;
    };

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function toDatetimeLocalValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function createDefaultScheduleDraft(): ScheduleDraft {
  const inOneHour = new Date(Date.now() + 60 * 60 * 1000);
  inOneHour.setSeconds(0, 0);
  return { kind: "once", at: toDatetimeLocalValue(inOneHour) };
}

export function scheduleSpecToDraft(spec: ScheduleSpec): ScheduleDraft {
  if (spec.kind === "once") {
    return { kind: "once", at: toDatetimeLocalValue(new Date(spec.at)) };
  }

  const recurring = (
    preset: RecurringPreset,
    time: string,
    weekday = "1",
  ): ScheduleDraft => ({
    kind: "recurring",
    preset,
    time,
    weekday,
    cron: spec.cron,
  });

  const cron = spec.cron.trim();
  const hourlyMatch = /^(\d{1,2}) \* \* \* \*$/.exec(cron);
  if (hourlyMatch) {
    return recurring("hourly", `00:${pad(Number(hourlyMatch[1]))}`);
  }
  const dailyLikeMatch = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(
    cron,
  );
  if (dailyLikeMatch) {
    const time = `${pad(Number(dailyLikeMatch[2]))}:${pad(
      Number(dailyLikeMatch[1]),
    )}`;
    const dayPart = dailyLikeMatch[3];
    if (dayPart === "*") {
      return recurring("daily", time);
    }
    if (dayPart === "1-5") {
      return recurring("weekdays", time);
    }
    return recurring("weekly", time, dayPart);
  }
  return recurring("custom", "09:00");
}

function buildCronFromDraft(
  draft: Extract<ScheduleDraft, { kind: "recurring" }>,
): string {
  if (draft.preset === "custom") {
    return draft.cron.trim();
  }

  const [hourPart = "9", minutePart = "0"] = draft.time.split(":");
  const hour = Number.parseInt(hourPart, 10) || 0;
  const minute = Number.parseInt(minutePart, 10) || 0;

  switch (draft.preset) {
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${draft.weekday}`;
  }
}

export function buildScheduleSpec(
  draft: ScheduleDraft,
): { schedule: ScheduleSpec } | { error: string } {
  if (draft.kind === "once") {
    const at = new Date(draft.at).getTime();
    if (Number.isNaN(at)) {
      return { error: "Pick a valid date and time." };
    }
    if (at <= Date.now()) {
      return { error: "Scheduled time must be in the future." };
    }
    return { schedule: { kind: "once", at } };
  }

  const cron = buildCronFromDraft(draft);
  if (!cron) {
    return { error: "Cron expression is required." };
  }
  const nextRun = getNextCronRun(cron);
  if (nextRun === null) {
    return { error: "Invalid cron expression." };
  }
  return { schedule: { kind: "recurring", cron } };
}

export function getNextCronRun(cron: string): Date | null {
  try {
    return new Cron(cron).nextRun();
  } catch {
    return null;
  }
}

export function formatRunTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function describeSchedule(schedule: ScheduleSpec): string {
  if (schedule.kind === "once") {
    return `Once at ${formatRunTime(schedule.at)}`;
  }
  return `Recurring (${schedule.cron})`;
}
