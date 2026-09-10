import { describe, expect, it } from "vitest";
import {
  cacheSavingsUsd,
  lookupRate,
  parseRateTable,
  priceUsage,
} from "../../../src/main/usage-history/pricing";

const TOTALS = {
  uncachedInputTokens: 1000,
  cachedInputTokens: 2000,
  cacheCreationTokens: 500,
  outputTokens: 100,
  reasoningTokens: 60,
};

describe("parseRateTable", () => {
  it("falls back to the input rate for missing cache rates", () => {
    const table = parseRateTable({
      "some/model": {
        input_cost_per_token: 3e-6,
        output_cost_per_token: 1.5e-5,
      },
    });
    expect(table.get("some/model")).toEqual({
      inputCostPerToken: 3e-6,
      outputCostPerToken: 1.5e-5,
      cacheReadCostPerToken: 3e-6,
      cacheCreationCostPerToken: 3e-6,
    });
  });

  it("keeps explicit cache rates", () => {
    const table = parseRateTable({
      "anthropic/claude-opus-5": {
        input_cost_per_token: 5e-6,
        output_cost_per_token: 2.5e-5,
        cache_read_input_token_cost: 5e-7,
        cache_creation_input_token_cost: 6.25e-6,
      },
    });
    expect(table.get("anthropic/claude-opus-5")?.cacheReadCostPerToken).toBe(
      5e-7,
    );
    expect(
      table.get("anthropic/claude-opus-5")?.cacheCreationCostPerToken,
    ).toBe(6.25e-6);
  });

  it("drops entries missing either half of the price", () => {
    const table = parseRateTable({
      "input-only": { input_cost_per_token: 1e-6 },
      "output-only": { output_cost_per_token: 1e-6 },
      "not-an-object": 5,
      "": { input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
    });
    expect(table.size).toBe(0);
  });

  it("lowercases and trims keys while keeping the provider prefix", () => {
    const table = parseRateTable({
      "  OpenAI/GPT-X  ": {
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
      },
    });
    expect(table.has("openai/gpt-x")).toBe(true);
  });

  it("aliases a bare name when every qualified entry agrees", () => {
    const table = parseRateTable({
      "openai/gpt-x": {
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
      },
      "azure/gpt-x": {
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
      },
    });
    expect(table.get("gpt-x")?.inputCostPerToken).toBe(1e-6);
  });

  it("poisons a bare name claimed at conflicting rates", () => {
    const table = parseRateTable({
      "openai/gpt-x": {
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
      },
      "azure/gpt-x": {
        input_cost_per_token: 9e-6,
        output_cost_per_token: 2e-6,
      },
    });
    expect(table.has("gpt-x")).toBe(false);
  });

  it("leaves a canonical bare entry alone", () => {
    const table = parseRateTable({
      "gpt-x": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
      "openai/gpt-x": {
        input_cost_per_token: 9e-6,
        output_cost_per_token: 2e-6,
      },
    });
    expect(table.get("gpt-x")?.inputCostPerToken).toBe(1e-6);
  });
});

describe("lookupRate", () => {
  const table = parseRateTable({
    "claude-fable-5-1": {
      input_cost_per_token: 1e-6,
      output_cost_per_token: 2e-6,
    },
  });

  it("strips a bracketed context-tier suffix", () => {
    expect(lookupRate(table, "claude-fable-5-1[1m]")?.inputCostPerToken).toBe(
      1e-6,
    );
  });

  it("refuses ids that cannot name one billed model", () => {
    const ambiguous = parseRateTable({
      opus: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
      "<synthetic>": {
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
      },
    });
    for (const model of [
      "<synthetic>",
      "synthetic",
      "opus",
      "sonnet",
      "haiku",
      "fable",
    ]) {
      expect(lookupRate(ambiguous, model)).toBeNull();
    }
  });
});

describe("priceUsage", () => {
  const table = parseRateTable({
    "claude-opus-5": {
      input_cost_per_token: 5e-6,
      output_cost_per_token: 2.5e-5,
      cache_read_input_token_cost: 5e-7,
      cache_creation_input_token_cost: 6.25e-6,
    },
  });

  it("charges each token class at its own rate and never charges reasoning", () => {
    const priced = priceUsage(table, "claude-opus-5", TOTALS);
    expect(priced.costSource).toBe("modelPriced");
    expect(priced.costUsd).toBeCloseTo(
      1000 * 5e-6 + 2000 * 5e-7 + 500 * 6.25e-6 + 100 * 2.5e-5,
      12,
    );

    expect(
      priceUsage(table, "claude-opus-5", { ...TOTALS, reasoningTokens: 100 })
        .costUsd,
    ).toBeCloseTo(priced.costUsd, 12);
  });

  it("reports an unknown model as unpriced rather than free-looking", () => {
    expect(priceUsage(table, "mystery-model", TOTALS)).toEqual({
      costUsd: 0,
      costSource: "unpriced",
    });
  });
});

describe("cacheSavingsUsd", () => {
  it("values cache reads at the gap to the full input rate", () => {
    const table = parseRateTable({
      "claude-opus-5": {
        input_cost_per_token: 5e-6,
        output_cost_per_token: 2.5e-5,
        cache_read_input_token_cost: 5e-7,
      },
    });
    expect(cacheSavingsUsd(table, "claude-opus-5", TOTALS)).toBeCloseTo(
      2000 * (5e-6 - 5e-7),
      12,
    );
  });

  it("claims nothing for an unpriced model", () => {
    expect(cacheSavingsUsd(new Map(), "mystery-model", TOTALS)).toBe(0);
  });
});
