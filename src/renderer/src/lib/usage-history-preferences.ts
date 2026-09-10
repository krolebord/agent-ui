export const USAGE_METRICS = ["cost", "tokens"] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

export const USAGE_WINDOW_DAYS = [7, 30, 90] as const;
export type UsageWindowDays = (typeof USAGE_WINDOW_DAYS)[number];

export interface UsagePagePreferences {
  metric: UsageMetric;
  windowDays: UsageWindowDays;
}

const STORAGE_KEY = "agent-ui:usage-page-preferences:v1";

const DEFAULTS: UsagePagePreferences = { metric: "cost", windowDays: 30 };

export function isUsageMetric(value: unknown): value is UsageMetric {
  return USAGE_METRICS.includes(value as UsageMetric);
}

export function isUsageWindowDays(value: unknown): value is UsageWindowDays {
  return USAGE_WINDOW_DAYS.includes(value as UsageWindowDays);
}

export function readUsagePagePreferences(): UsagePagePreferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return DEFAULTS;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return DEFAULTS;
    }
    const { metric, windowDays } = parsed as Record<string, unknown>;
    return {
      metric: isUsageMetric(metric) ? metric : DEFAULTS.metric,
      windowDays: isUsageWindowDays(windowDays)
        ? windowDays
        : DEFAULTS.windowDays,
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveUsagePagePreferences(
  preferences: UsagePagePreferences,
): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {}
}
