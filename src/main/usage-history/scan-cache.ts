import path from "node:path";
import {
  USAGE_HISTORY_PROVIDERS,
  type UsageHistoryProvider,
} from "@shared/usage-history";
import type { UsageRecord } from "./transcripts";

const SCAN_CACHE_VERSION = 2 as const;

export interface CachedFile {
  size: number;
  mtimeMs: number;
  provider: UsageHistoryProvider;
  records: UsageRecord[];
}

export type ScanCache = Map<string, CachedFile>;

type SerializedRecord = [
  timestampMs: number,
  modelIndex: number,
  sessionIndex: number,
  uncachedInputTokens: number,
  cachedInputTokens: number,
  cacheCreationTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  dedupeKey: string | null,
  costUsd: number | null,
];

interface SerializedFile {
  s: number;
  m: number;
  p: UsageHistoryProvider;
  r: SerializedRecord[];
}

interface SerializedCache {
  version: number;
  models: string[];
  sessions: string[];
  files: Record<string, SerializedFile>;
}

export function encodeScanCache(cache: ScanCache): SerializedCache {
  const models: string[] = [];
  const sessions: string[] = [];
  const modelIndex = new Map<string, number>();
  const sessionIndex = new Map<string, number>();

  const intern = (
    table: string[],
    index: Map<string, number>,
    value: string,
  ): number => {
    const existing = index.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const next = table.length;
    table.push(value);
    index.set(value, next);
    return next;
  };

  const files: Record<string, SerializedFile> = {};
  for (const [filePath, entry] of cache) {
    files[filePath] = {
      s: entry.size,
      m: entry.mtimeMs,
      p: entry.provider,
      r: entry.records.map((record) => [
        record.timestampMs,
        intern(models, modelIndex, record.model),
        intern(sessions, sessionIndex, record.sessionId),
        record.totals.uncachedInputTokens,
        record.totals.cachedInputTokens,
        record.totals.cacheCreationTokens,
        record.totals.outputTokens,
        record.totals.reasoningTokens,
        record.dedupeKey,
        record.costUsd,
      ]),
    };
  }

  return { version: SCAN_CACHE_VERSION, models, sessions, files };
}

function isProvider(value: unknown): value is UsageHistoryProvider {
  return USAGE_HISTORY_PROVIDERS.includes(value as UsageHistoryProvider);
}

function allStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

export function decodeScanCache(document: unknown): ScanCache {
  const cache: ScanCache = new Map();
  if (typeof document !== "object" || document === null) {
    return cache;
  }

  const root = document as Partial<SerializedCache>;
  if (root.version !== SCAN_CACHE_VERSION) {
    return cache;
  }
  if (!allStrings(root.models) || !allStrings(root.sessions)) {
    return cache;
  }
  if (typeof root.files !== "object" || root.files === null) {
    return cache;
  }
  const models = root.models;
  const sessions = root.sessions;

  const decodeRecords = (
    rows: unknown,
    provider: UsageHistoryProvider,
  ): UsageRecord[] | null => {
    if (!Array.isArray(rows)) {
      return null;
    }
    const records: UsageRecord[] = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 10) {
        return null;
      }
      const [
        timestampMs,
        modelIndex,
        sessionIndex,
        uncached,
        cached,
        cacheCreation,
        output,
        reasoning,
        dedupeKey,
        costUsd,
      ] = row as SerializedRecord;

      const model =
        typeof modelIndex === "number" ? models[modelIndex] : undefined;
      if (
        typeof timestampMs !== "number" ||
        !Number.isFinite(timestampMs) ||
        model === undefined ||
        !Number.isFinite(uncached) ||
        !Number.isFinite(cached) ||
        !Number.isFinite(cacheCreation) ||
        !Number.isFinite(output) ||
        !Number.isFinite(reasoning)
      ) {
        return null;
      }

      records.push({
        provider,
        timestampMs,
        model,
        sessionId:
          (typeof sessionIndex === "number"
            ? sessions[sessionIndex]
            : undefined) ?? "",
        totals: {
          uncachedInputTokens: uncached,
          cachedInputTokens: cached,
          cacheCreationTokens: cacheCreation,
          outputTokens: output,
          reasoningTokens: reasoning,
        },
        dedupeKey: typeof dedupeKey === "string" ? dedupeKey : null,
        costUsd: typeof costUsd === "number" ? costUsd : null,
      });
    }
    return records;
  };

  for (const [filePath, raw] of Object.entries(root.files)) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const entry = raw as Partial<SerializedFile>;
    if (typeof entry.s !== "number" || typeof entry.m !== "number") {
      continue;
    }
    if (!isProvider(entry.p)) {
      continue;
    }
    const records = decodeRecords(entry.r, entry.p);
    if (records === null) {
      continue;
    }
    cache.set(filePath, {
      size: entry.s,
      mtimeMs: entry.m,
      provider: entry.p,
      records,
    });
  }

  return cache;
}

export interface PruneScanCacheOptions {
  livePaths: ReadonlySet<string>;
  walkedRoots: string[];
  windowStartMs: number;
  retentionCutoffMs: number;
}

function isUnder(root: string, filePath: string): boolean {
  return filePath === root || filePath.startsWith(root + path.sep);
}

export function pruneScanCache(
  cache: ScanCache,
  options: PruneScanCacheOptions,
): number {
  let removed = 0;
  for (const [filePath, entry] of cache) {
    const agedOut = entry.mtimeMs < options.retentionCutoffMs;
    const deleted =
      options.walkedRoots.some((root) => isUnder(root, filePath)) &&
      entry.mtimeMs >= options.windowStartMs &&
      !options.livePaths.has(filePath);
    if (agedOut || deleted) {
      cache.delete(filePath);
      removed += 1;
    }
  }
  return removed;
}

export function dedupeWithinFile(records: UsageRecord[]): UsageRecord[] {
  const seen = new Set<string>();
  const kept: UsageRecord[] = [];
  for (const record of records) {
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) {
        continue;
      }
      seen.add(record.dedupeKey);
    }
    kept.push(record);
  }
  return kept;
}
