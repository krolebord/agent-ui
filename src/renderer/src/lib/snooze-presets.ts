/**
 * Snooze preset resolution and wake labels for the inbox sidebar.
 *
 * Pure functions over epoch milliseconds so the boundary math (evening,
 * tomorrow, next week) is unit-testable without a DOM, and so the whole module
 * matches the millisecond timestamps the session lifecycle already uses.
 *
 * Presets deliberately skew short: session rhythms here are hours — a CI run, a
 * review, the next sitting — not days.
 */

const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

export interface SnoozePreset {
  id: "hour" | "evening" | "tomorrow" | "next-week";
  label: string;
  /**
   * The menu row's trailing time column. Complements the label instead of
   * repeating it: "Tomorrow" pairs with "9:00 AM", not "tomorrow 9:00 AM".
   */
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

/**
 * Advances by calendar days rather than adding DAY_MS: a fixed millisecond
 * offset lands on the wrong local day across a DST transition, since a
 * spring-forward day is 23 hours and 23:30 + 24h skips the next day entirely.
 */
function addDays(timestamp: number, days: number): number {
  const date = new Date(timestamp);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/** Presets for "snooze until", resolved against local time. */
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

  // Dropped once evening is within an hour or already past: it would either
  // duplicate "In 1 hour" or point at a time the router would reject.
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

  // Next Monday 9:00 — a full week out when today is already Monday.
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

/**
 * Countdown for a snoozed row's timestamp slot.
 *
 * Prefixed with "in" on purpose: settled rows in the adjacent shelf render a
 * bare "3h" meaning three hours *ago*, so an unprefixed countdown would read as
 * the opposite of what it means. Minutes round up so a row still on the shelf
 * never claims to wake in "0m".
 */
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

/** Spelled-out wake time for tooltips: "9:00 AM", "tomorrow 9:00 AM". */
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
