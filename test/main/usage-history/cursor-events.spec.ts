import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CURSOR_USAGE_ENDPOINT,
  fetchCursorUsageRecords,
  toUsageRecord,
  UNKNOWN_CURSOR_MODEL,
} from "../../../src/main/usage-history/cursor-events";

function event(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: "1789037279517",
    model: "composer-2.5-fast",
    conversationId: "conv-1",
    chargedCents: 2.6539,
    tokenUsage: {
      inputTokens: 7681,
      outputTokens: 40,
      cacheReadTokens: 5792,
    },
    ...overrides,
  };
}

function page(rows: unknown[], total: number) {
  return {
    ok: true,
    json: async () => ({
      totalUsageEventsCount: total,
      usageEventsDisplay: rows,
    }),
  } as unknown as Response;
}

describe("toUsageRecord", () => {
  it("splits the dashboard token fields into the shared totals", () => {
    expect(toUsageRecord(event())).toEqual({
      provider: "cursor",
      timestampMs: 1789037279517,
      model: "composer-2.5-fast",
      sessionId: "conv-1",
      totals: {
        uncachedInputTokens: 7681,
        cachedInputTokens: 5792,
        cacheCreationTokens: 0,
        outputTokens: 40,
        reasoningTokens: 0,
      },
      dedupeKey: "1789037279517:conv-1:composer-2.5-fast:0.026539",
      costUsd: 0.026539,
    });
  });

  it("reads cache writes and numeric timestamps", () => {
    const record = toUsageRecord(
      event({
        timestamp: 1789037279517,
        tokenUsage: { inputTokens: 10, outputTokens: 2, cacheWriteTokens: 7 },
      }),
    );
    expect(record?.totals.cacheCreationTokens).toBe(7);
    expect(record?.totals.cachedInputTokens).toBe(0);
  });

  it("keeps a billed event that carries no token usage", () => {
    const record = toUsageRecord(event({ tokenUsage: undefined }));
    expect(record?.costUsd).toBeCloseTo(0.026539, 10);
    expect(record?.totals.outputTokens).toBe(0);
  });

  it("falls back to a placeholder model", () => {
    expect(toUsageRecord(event({ model: "  " }))?.model).toBe(
      UNKNOWN_CURSOR_MODEL,
    );
  });

  it("rejects an event with no usable timestamp", () => {
    expect(toUsageRecord(event({ timestamp: "not-a-number" }))).toBeNull();
    expect(toUsageRecord(event({ timestamp: 0 }))).toBeNull();
    expect(toUsageRecord(null)).toBeNull();
  });
});

describe("fetchCursorUsageRecords", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the window as millisecond strings", async () => {
    const fetchImpl = vi.fn(async () => page([event()], 1));
    await fetchCursorUsageRecords({
      accessToken: "token",
      startMs: 1786406400000,
      endMs: 1789084800000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(CURSOR_USAGE_ENDPOINT);
    expect(JSON.parse(String(init.body))).toEqual({
      startDate: "1786406400000",
      endDate: "1789084800000",
      page: 1,
      pageSize: 1000,
    });
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer token",
    );
  });

  it("stops once a short page arrives", async () => {
    const fetchImpl = vi.fn(async () => page([event()], 1));
    const result = await fetchCursorUsageRecords({
      accessToken: "token",
      startMs: 0,
      endMs: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.pages).toBe(1);
    expect(result.records).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("pages until the reported total is covered", async () => {
    const full = Array.from({ length: 1000 }, (_, index) =>
      event({ timestamp: String(1789037279517 + index) }),
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(page(full, 1500))
      .mockResolvedValueOnce(page(full.slice(0, 500), 1500));

    const result = await fetchCursorUsageRecords({
      accessToken: "token",
      startMs: 0,
      endMs: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.pages).toBe(2);
    expect(result.records).toHaveLength(1500);
  });

  it("throws when the endpoint rejects the request", async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
        }) as unknown as Response,
    );
    await expect(
      fetchCursorUsageRecords({
        accessToken: "token",
        startMs: 0,
        endMs: 1,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow("401");
  });
});
