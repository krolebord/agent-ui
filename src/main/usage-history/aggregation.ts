import {
  addUsageTotals,
  EMPTY_USAGE_TOTALS,
  type UsageHistoryBucket,
  type UsageHistoryProvider,
  type UsageTokenTotals,
} from "@shared/usage-history";
import { cacheSavingsUsd, priceUsage, type RateTable } from "./pricing";
import type { UsageRecord } from "./transcripts";

function makeDayFormatter(timeZone: string): (timestampMs: number) => string {
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", { ...options, timeZone });
  } catch {
    format = new Intl.DateTimeFormat("en-CA", { ...options, timeZone: "UTC" });
  }
  return (timestampMs) => format.format(new Date(timestampMs));
}

interface MutableBucket {
  totals: UsageTokenTotals;
  costUsd: number;
  cacheSavingsUsd: number;
  records: number;
  unpricedRecords: number;
  providerReportedRecords: number;
  sessions: Set<string>;
}

export interface UsageAggregateOptions {
  timeZone: string;
  sinceDay: string;
  untilDay: string;
  rates: RateTable;
}

export interface UsageAggregateResult {
  buckets: UsageHistoryBucket[];
  duplicatesDropped: number;
  outOfWindow: number;
}

const KEY_SEPARATOR = "\u0000";

function resolveCostSource(
  bucket: MutableBucket,
): UsageHistoryBucket["costSource"] {
  if (bucket.providerReportedRecords === bucket.records) {
    return "providerReported";
  }
  if (bucket.unpricedRecords === bucket.records) {
    return "unpriced";
  }
  return "modelPriced";
}

export class UsageHistoryAggregator {
  private readonly buckets = new Map<string, MutableBucket>();
  private readonly seen = new Set<string>();
  private readonly toDay: (timestampMs: number) => string;
  private duplicatesDropped = 0;
  private outOfWindow = 0;

  constructor(private readonly options: UsageAggregateOptions) {
    this.toDay = makeDayFormatter(options.timeZone);
  }

  add(record: UsageRecord): boolean {
    if (record.dedupeKey !== null) {
      if (this.seen.has(record.dedupeKey)) {
        this.duplicatesDropped += 1;
        return false;
      }
      this.seen.add(record.dedupeKey);
    }

    const day = this.toDay(record.timestampMs);
    if (day < this.options.sinceDay || day > this.options.untilDay) {
      this.outOfWindow += 1;
      return false;
    }

    const key = `${day}${KEY_SEPARATOR}${record.provider}${KEY_SEPARATOR}${record.model}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        totals: EMPTY_USAGE_TOTALS,
        costUsd: 0,
        cacheSavingsUsd: 0,
        records: 0,
        unpricedRecords: 0,
        providerReportedRecords: 0,
        sessions: new Set<string>(),
      };
      this.buckets.set(key, bucket);
    }

    bucket.totals = addUsageTotals(bucket.totals, record.totals);
    bucket.records += 1;

    if (record.costUsd !== null) {
      bucket.costUsd += record.costUsd;
      bucket.providerReportedRecords += 1;
    } else {
      const priced = priceUsage(
        this.options.rates,
        record.model,
        record.totals,
      );
      bucket.costUsd += priced.costUsd;
      bucket.cacheSavingsUsd += cacheSavingsUsd(
        this.options.rates,
        record.model,
        record.totals,
      );
      if (priced.costSource === "unpriced") {
        bucket.unpricedRecords += 1;
      }
    }
    if (record.sessionId.length > 0) {
      bucket.sessions.add(record.sessionId);
    }
    return true;
  }

  finish(): UsageAggregateResult {
    const buckets: UsageHistoryBucket[] = [];
    for (const [key, bucket] of this.buckets) {
      const [day = "", provider = "", model = ""] = key.split(KEY_SEPARATOR);
      buckets.push({
        day,
        provider: provider as UsageHistoryProvider,
        model,
        totals: bucket.totals,
        costUsd: bucket.costUsd,
        cacheSavingsUsd: bucket.cacheSavingsUsd,
        costSource: resolveCostSource(bucket),
        records: bucket.records,
        unpricedRecords: bucket.unpricedRecords,
        sessions: bucket.sessions.size,
      });
    }

    buckets.sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    );

    return {
      buckets,
      duplicatesDropped: this.duplicatesDropped,
      outOfWindow: this.outOfWindow,
    };
  }
}
