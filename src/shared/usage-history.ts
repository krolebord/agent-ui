import * as z from "zod";

export const USAGE_HISTORY_PROVIDERS = ["claude", "codex", "cursor"] as const;

export type UsageHistoryProvider = (typeof USAGE_HISTORY_PROVIDERS)[number];

export interface UsageTokenTotals {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export const EMPTY_USAGE_TOTALS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

export function addUsageTotals(
  a: UsageTokenTotals,
  b: UsageTokenTotals,
): UsageTokenTotals {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

export function totalUsageTokens(totals: UsageTokenTotals): number {
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

export type UsageCostSource = "modelPriced" | "providerReported" | "unpriced";

export interface UsageHistoryBucket {
  day: string;
  provider: UsageHistoryProvider;
  model: string;
  totals: UsageTokenTotals;
  costUsd: number;
  cacheSavingsUsd: number;
  costSource: UsageCostSource;
  records: number;
  unpricedRecords: number;
  sessions: number;
}

export type UsageHistorySourceStatus =
  | "ok"
  | "missing"
  | "failed"
  | "unauthenticated";

export type UsageHistorySourceKind = "transcripts" | "api";

export interface UsageHistorySource {
  provider: UsageHistoryProvider;
  kind: UsageHistorySourceKind;
  origin: string;
  status: UsageHistorySourceStatus;
  scannedFiles: number;
  skippedFiles: number;
  distinctSessions: number;
  message: string | null;
}

export type UsagePricingStatus = "fresh" | "cached" | "unavailable";

export interface UsageHistoryPricing {
  status: UsagePricingStatus;
  fetchedAt: string | null;
  knownModels: number;
}

export interface UsageHistorySummary {
  readAt: string;
  timeZone: string;
  sinceDay: string;
  untilDay: string;
  buckets: UsageHistoryBucket[];
  sources: UsageHistorySource[];
  pricing: UsageHistoryPricing;
  scanDurationMs: number;
}

const usageDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((day) => !Number.isNaN(Date.parse(`${day}T00:00:00Z`)), {
    message: "Not a calendar day",
  });

export const usageHistorySummaryInputSchema = z
  .object({
    sinceDay: usageDaySchema,
    untilDay: usageDaySchema,
    timeZone: z.string().min(1),
  })
  .refine((input) => input.sinceDay <= input.untilDay, {
    message: "sinceDay must not be after untilDay",
  });

export type UsageHistorySummaryInput = z.infer<
  typeof usageHistorySummaryInputSchema
>;
