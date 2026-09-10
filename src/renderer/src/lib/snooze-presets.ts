const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

export interface SnoozePreset {
  id: "hour" | "evening" | "tomorrow" | "next-week";
  label: string;
  whenLabel: string;
  snoozedUntil: number;
}

function timeOfDayLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function atHour(timestamp: number, hour: number): number {
  const date = new Date(timestamp);
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
}

function addDays(timestamp: number, days: number): number {
  const date = new Date(timestamp);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

export function resolveSnoozePresets(now: number): SnoozePreset[] {
  const inAnHour = now + HOUR_MS;
  const presets: SnoozePreset[] = [
    {
      id: "hour",
      label: "In 1 hour",
      whenLabel: timeOfDayLabel(inAnHour),
      snoozedUntil: inAnHour,
    },
  ];

  const evening = atHour(now, EVENING_HOUR);
  if (evening - now > HOUR_MS) {
    presets.push({
      id: "evening",
      label: "This evening",
      whenLabel: timeOfDayLabel(evening),
      snoozedUntil: evening,
    });
  }

  const tomorrow = atHour(addDays(now, 1), MORNING_HOUR);
  presets.push({
    id: "tomorrow",
    label: "Tomorrow",
    whenLabel: timeOfDayLabel(tomorrow),
    snoozedUntil: tomorrow,
  });

  const daysUntilMonday = (1 - new Date(now).getDay() + 7) % 7 || 7;
  const nextWeek = atHour(addDays(now, daysUntilMonday), MORNING_HOUR);
  presets.push({
    id: "next-week",
    label: "Next week",
    whenLabel: `${new Date(nextWeek).toLocaleDateString(undefined, {
      weekday: "short",
    })} ${timeOfDayLabel(nextWeek)}`,
    snoozedUntil: nextWeek,
  });

  return presets;
}

export function snoozeWakeLabel(snoozedUntil: number, now: number): string {
  const remainingMs = snoozedUntil - now;
  if (remainingMs <= 0) {
    return "now";
  }
  if (remainingMs < HOUR_MS) {
    return `in ${Math.max(1, Math.ceil(remainingMs / MINUTE_MS))}m`;
  }
  if (remainingMs < DAY_MS) {
    return `in ${Math.ceil(remainingMs / HOUR_MS)}h`;
  }
  return `in ${Math.ceil(remainingMs / DAY_MS)}d`;
}

export function snoozeWakeDescription(
  snoozedUntil: number,
  now: number,
): string {
  const time = timeOfDayLabel(snoozedUntil);
  const dayDelta = Math.floor((snoozedUntil - atHour(now, 0)) / DAY_MS);
  if (dayDelta <= 0) {
    return time;
  }
  if (dayDelta === 1) {
    return `tomorrow ${time}`;
  }
  const wake = new Date(snoozedUntil);
  if (dayDelta < 7) {
    return `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  }
  return `${wake.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })}, ${time}`;
}
