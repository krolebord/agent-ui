import type { UsageCostSource, UsageTokenTotals } from "@shared/usage-history";

export interface ModelRate {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadCostPerToken: number;
  cacheCreationCostPerToken: number;
}

export type RateTable = ReadonlyMap<string, ModelRate>;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeRateKey(model: string): string {
  return model.trim().toLowerCase();
}

function bareModelName(key: string): string {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
}

function stripVariantSuffix(key: string): string {
  const bracket = key.indexOf("[");
  return bracket === -1 ? key : key.slice(0, bracket);
}

function sameRate(a: ModelRate, b: ModelRate): boolean {
  return (
    a.inputCostPerToken === b.inputCostPerToken &&
    a.outputCostPerToken === b.outputCostPerToken &&
    a.cacheReadCostPerToken === b.cacheReadCostPerToken &&
    a.cacheCreationCostPerToken === b.cacheCreationCostPerToken
  );
}

export function parseRateTable(document: unknown): RateTable {
  const table = new Map<string, ModelRate>();
  if (typeof document !== "object" || document === null) {
    return table;
  }

  for (const [name, raw] of Object.entries(
    document as Record<string, unknown>,
  )) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const input = finiteNumber(entry.input_cost_per_token);
    const output = finiteNumber(entry.output_cost_per_token);
    if (input === null || output === null) {
      continue;
    }

    const key = normalizeRateKey(name);
    if (key.length === 0) {
      continue;
    }
    table.set(key, {
      inputCostPerToken: input,
      outputCostPerToken: output,
      cacheReadCostPerToken:
        finiteNumber(entry.cache_read_input_token_cost) ?? input,
      cacheCreationCostPerToken:
        finiteNumber(entry.cache_creation_input_token_cost) ?? input,
    });
  }

  const aliasCandidates = new Map<string, ModelRate | null>();
  for (const [key, rate] of table) {
    const alias = bareModelName(key);
    if (alias.length === 0 || alias === key || table.has(alias)) {
      continue;
    }
    const held = aliasCandidates.get(alias);
    if (held === undefined) {
      aliasCandidates.set(alias, rate);
    } else if (held !== null && !sameRate(held, rate)) {
      aliasCandidates.set(alias, null);
    }
  }
  for (const [alias, rate] of aliasCandidates) {
    if (rate !== null) {
      table.set(alias, rate);
    }
  }

  return table;
}

const UNPRICEABLE_MODELS = new Set([
  "<synthetic>",
  "synthetic",
  "opus",
  "sonnet",
  "haiku",
  "fable",
]);

export function lookupRate(table: RateTable, model: string): ModelRate | null {
  const key = stripVariantSuffix(normalizeRateKey(model));
  const bareName = bareModelName(key);
  if (bareName.length === 0 || UNPRICEABLE_MODELS.has(bareName)) {
    return null;
  }
  return table.get(key) ?? null;
}

export interface PricedUsage {
  costUsd: number;
  costSource: UsageCostSource;
}

export function priceUsage(
  table: RateTable,
  model: string,
  totals: UsageTokenTotals,
): PricedUsage {
  const rate = lookupRate(table, model);
  if (rate === null) {
    return { costUsd: 0, costSource: "unpriced" };
  }

  return {
    costUsd:
      totals.uncachedInputTokens * rate.inputCostPerToken +
      totals.cachedInputTokens * rate.cacheReadCostPerToken +
      totals.cacheCreationTokens * rate.cacheCreationCostPerToken +
      totals.outputTokens * rate.outputCostPerToken,
    costSource: "modelPriced",
  };
}

export function cacheSavingsUsd(
  table: RateTable,
  model: string,
  totals: UsageTokenTotals,
): number {
  const rate = lookupRate(table, model);
  if (rate === null) {
    return 0;
  }
  return (
    totals.cachedInputTokens *
    (rate.inputCostPerToken - rate.cacheReadCostPerToken)
  );
}
