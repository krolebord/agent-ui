import {
  totalUsageTokens,
  USAGE_HISTORY_PROVIDERS,
  type UsageHistoryProvider,
  type UsageHistorySummary,
  type UsageHistorySummaryInput,
} from "@shared/usage-history";

export interface UsageValuePair {
  costUsd: number;
  totalTokens: number;
}

export interface UsageProviderTotals extends UsageValuePair {
  provider: UsageHistoryProvider;
  sessions: number;
  costShare: number;
  tokenShare: number;
}

export interface UsageModelTotals extends UsageValuePair {
  provider: UsageHistoryProvider;
  model: string;
  costShare: number;
  tokenShare: number;
}

export interface UsageDayTotals extends UsageValuePair {
  day: string;
  byProvider: Map<UsageHistoryProvider, UsageValuePair>;
}

/**
 * Where the displayed cost came from: rate-table estimates, amounts the
 * provider actually billed, or a blend of the two.
 */
export type UsageCostBasis = "none" | "estimated" | "billed" | "mixed";

export interface UsageHistoryView {
  costUsd: number;
  costBasis: UsageCostBasis;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheSavingsUsd: number;
  sessions: number;
  unpricedRecords: number;
  providers: UsageProviderTotals[];
  models: UsageModelTotals[];
  daily: UsageDayTotals[];
  activeProviders: UsageHistoryProvider[];
}

export const EMPTY_USAGE_HISTORY_VIEW: UsageHistoryView = {
  costUsd: 0,
  costBasis: "none",
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheSavingsUsd: 0,
  sessions: 0,
  unpricedRecords: 0,
  providers: [],
  models: [],
  daily: [],
  activeProviders: [],
};

export function deriveUsageHistoryView(
  summary: UsageHistorySummary | undefined,
): UsageHistoryView {
  if (!summary) {
    return EMPTY_USAGE_HISTORY_VIEW;
  }

  const view = {
    ...EMPTY_USAGE_HISTORY_VIEW,
    providers: [] as UsageProviderTotals[],
    models: [] as UsageModelTotals[],
    daily: [] as UsageDayTotals[],
    activeProviders: [] as UsageHistoryProvider[],
  };

  const providerAccumulator = new Map<
    UsageHistoryProvider,
    UsageValuePair & { sessions: number }
  >();
  const modelAccumulator = new Map<
    string,
    UsageValuePair & { provider: UsageHistoryProvider; model: string }
  >();
  const dayAccumulator = new Map<string, UsageDayTotals>();
  let billedBuckets = 0;
  let estimatedBuckets = 0;

  for (const source of summary.sources) {
    view.sessions += source.distinctSessions;
    const provider = providerAccumulator.get(source.provider) ?? {
      costUsd: 0,
      totalTokens: 0,
      sessions: 0,
    };
    provider.sessions += source.distinctSessions;
    providerAccumulator.set(source.provider, provider);
  }

  for (const bucket of summary.buckets) {
    const tokens = totalUsageTokens(bucket.totals);

    view.costUsd += bucket.costUsd;
    view.cacheSavingsUsd += bucket.cacheSavingsUsd;
    view.uncachedInputTokens += bucket.totals.uncachedInputTokens;
    view.cachedInputTokens += bucket.totals.cachedInputTokens;
    view.cacheCreationTokens += bucket.totals.cacheCreationTokens;
    view.outputTokens += bucket.totals.outputTokens;
    view.totalTokens += tokens;
    view.unpricedRecords += bucket.unpricedRecords;

    if (bucket.costSource === "providerReported") {
      billedBuckets += 1;
    } else if (bucket.costSource === "modelPriced") {
      estimatedBuckets += 1;
    }

    const provider = providerAccumulator.get(bucket.provider) ?? {
      costUsd: 0,
      totalTokens: 0,
      sessions: 0,
    };
    provider.costUsd += bucket.costUsd;
    provider.totalTokens += tokens;
    providerAccumulator.set(bucket.provider, provider);

    const modelKey = `${bucket.provider}/${bucket.model}`;
    const model = modelAccumulator.get(modelKey) ?? {
      provider: bucket.provider,
      model: bucket.model,
      costUsd: 0,
      totalTokens: 0,
    };
    model.costUsd += bucket.costUsd;
    model.totalTokens += tokens;
    modelAccumulator.set(modelKey, model);

    const day = dayAccumulator.get(bucket.day) ?? {
      day: bucket.day,
      costUsd: 0,
      totalTokens: 0,
      byProvider: new Map<UsageHistoryProvider, UsageValuePair>(),
    };
    day.costUsd += bucket.costUsd;
    day.totalTokens += tokens;
    const dayProvider = day.byProvider.get(bucket.provider) ?? {
      costUsd: 0,
      totalTokens: 0,
    };
    dayProvider.costUsd += bucket.costUsd;
    dayProvider.totalTokens += tokens;
    day.byProvider.set(bucket.provider, dayProvider);
    dayAccumulator.set(bucket.day, day);
  }

  const share = (part: number, whole: number) =>
    whole === 0 ? 0 : part / whole;

  view.providers = [...providerAccumulator]
    .map(([provider, totals]) => ({
      provider,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      sessions: totals.sessions,
      costShare: share(totals.costUsd, view.costUsd),
      tokenShare: share(totals.totalTokens, view.totalTokens),
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  view.models = [...modelAccumulator.values()]
    .map((totals) => ({
      ...totals,
      costShare: share(totals.costUsd, view.costUsd),
      tokenShare: share(totals.totalTokens, view.totalTokens),
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);

  view.daily = [...dayAccumulator.values()].sort((a, b) =>
    a.day.localeCompare(b.day),
  );

  if (billedBuckets > 0 && estimatedBuckets > 0) {
    view.costBasis = "mixed";
  } else if (billedBuckets > 0) {
    view.costBasis = "billed";
  } else if (estimatedBuckets > 0) {
    view.costBasis = "estimated";
  }

  const active = new Set(
    view.providers
      .filter((entry) => entry.totalTokens > 0 || entry.costUsd > 0)
      .map((entry) => entry.provider),
  );
  view.activeProviders = USAGE_HISTORY_PROVIDERS.filter((provider) =>
    active.has(provider),
  );

  return view;
}

export function sortModelsForMetric(
  models: UsageModelTotals[],
  metric: "cost" | "tokens",
): UsageModelTotals[] {
  if (metric === "cost") {
    return models;
  }
  return [...models].sort(
    (a, b) => b.totalTokens - a.totalTokens || b.costUsd - a.costUsd,
  );
}

export function bucketValue(
  pair: UsageValuePair | undefined,
  metric: "cost" | "tokens",
): number {
  if (!pair) {
    return 0;
  }
  return metric === "cost" ? pair.costUsd : pair.totalTokens;
}

function resolveTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function makeUsageWindow(
  days: number,
  now: Date = new Date(),
): UsageHistorySummaryInput {
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  let timeZone = resolveTimeZone();
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", { ...options, timeZone });
  } catch {
    timeZone = "UTC";
    format = new Intl.DateTimeFormat("en-CA", { ...options, timeZone });
  }

  const untilDay = format.format(now);
  const [year = 0, month = 1, dayOfMonth = 1] = untilDay
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const start = new Date(Date.UTC(year, month - 1, dayOfMonth - (days - 1)));

  return {
    sinceDay: start.toISOString().slice(0, 10),
    untilDay,
    timeZone,
  };
}
