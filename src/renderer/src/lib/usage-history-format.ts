const CURRENCY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INTEGER = new Intl.NumberFormat("en-US");

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const DAY_MS = 24 * 60 * 60 * 1000;

export function formatUsd(value: number): string {
  return CURRENCY.format(value);
}

export function formatCount(value: number): string {
  return INTEGER.format(Math.round(value));
}

function trim(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "");
}

export function formatTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) {
    return `${trim(value / 1e12)}T`;
  }
  if (abs >= 1e9) {
    return `${trim(value / 1e9)}B`;
  }
  if (abs >= 1e6) {
    return `${trim(value / 1e6)}M`;
  }
  if (abs >= 1e3) {
    return `${trim(value / 1e3)}K`;
  }
  return INTEGER.format(Math.round(value));
}

export function formatPercent(share: number, digits = 1): string {
  return `${(share * 100).toFixed(digits)}%`;
}

export function formatDayShort(day: string): string {
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  if (
    year === undefined ||
    month === undefined ||
    dayOfMonth === undefined ||
    Number.isNaN(month) ||
    Number.isNaN(dayOfMonth)
  ) {
    return day;
  }
  const name = MONTHS[month - 1];
  return name === undefined ? day : `${name} ${dayOfMonth}`;
}

export function enumerateDays(sinceDay: string, untilDay: string): string[] {
  const days: string[] = [];
  const start = Date.parse(`${sinceDay}T00:00:00Z`);
  const end = Date.parse(`${untilDay}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return days;
  }
  for (let cursor = start; cursor <= end; cursor += DAY_MS) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}
