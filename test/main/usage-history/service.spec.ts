import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageRecord } from "../../../src/main/usage-history/transcripts";

const readerMocks = vi.hoisted(() => ({
  readTranscriptRecords: vi.fn(),
}));
const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

vi.mock("../../../src/main/logger", () => ({ default: loggerMocks }));
vi.mock("../../../src/main/usage-history/transcript-reader", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/main/usage-history/transcript-reader")
  >("../../../src/main/usage-history/transcript-reader");
  return {
    ...actual,
    readTranscriptRecords: readerMocks.readTranscriptRecords,
  };
});

import { UsageHistoryService } from "../../../src/main/usage-history/service";

const WINDOW = {
  sinceDay: "2026-09-01",
  untilDay: "2026-09-30",
  timeZone: "UTC",
};

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    timestampMs: Date.parse("2026-09-09T12:00:00.000Z"),
    model: "claude-opus-5",
    sessionId: "session-1",
    totals: {
      uncachedInputTokens: 10,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 5,
      reasoningTokens: 0,
    },
    dedupeKey: null,
    costUsd: null,
    ...overrides,
  };
}

describe("UsageHistoryService", () => {
  let root: string;
  let userDataPath: string;
  let claudeProjects: string;
  let transcript: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    root = await fsp.mkdtemp(path.join(tmpdir(), "usage-history-"));
    userDataPath = path.join(root, "userData");
    claudeProjects = path.join(root, "home", ".claude", "projects");
    await fsp.mkdir(userDataPath, { recursive: true });
    await fsp.mkdir(claudeProjects, { recursive: true });
    transcript = path.join(claudeProjects, "a.jsonl");
    await fsp.writeFile(transcript, "line\n", "utf8");

    readerMocks.readTranscriptRecords.mockResolvedValue([record()]);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fsp.rm(root, { recursive: true, force: true });
  });

  function createService(
    overrides: Partial<
      ConstructorParameters<typeof UsageHistoryService>[0]
    > = {},
  ) {
    return new UsageHistoryService({
      userDataPath,
      homeDir: path.join(root, "home"),
      env: {},
      readCursorAccessToken: async () => null,
      ...overrides,
    });
  }

  it("reuses a cached parse while size and mtime are unchanged", async () => {
    const service = createService();
    const first = await service.readSummary(WINDOW);
    expect(first.buckets[0]?.totals.outputTokens).toBe(5);
    expect(readerMocks.readTranscriptRecords).toHaveBeenCalledTimes(1);

    await service.readSummary(WINDOW);
    expect(readerMocks.readTranscriptRecords).toHaveBeenCalledTimes(1);
  });

  it("re-parses once the file changes", async () => {
    const service = createService();
    await service.readSummary(WINDOW);

    await fsp.writeFile(transcript, "line\nline\n", "utf8");
    const later = new Date(Date.now() + 60_000);
    await fsp.utimes(transcript, later, later);

    readerMocks.readTranscriptRecords.mockResolvedValue([
      record(),
      record({ sessionId: "session-2" }),
    ]);
    const summary = await service.readSummary(WINDOW);
    expect(readerMocks.readTranscriptRecords).toHaveBeenCalledTimes(2);
    expect(summary.buckets[0]?.records).toBe(2);
  });

  it("does not cache a read failure as an empty transcript", async () => {
    readerMocks.readTranscriptRecords.mockResolvedValue(null);
    const service = createService();
    const empty = await service.readSummary(WINDOW);
    expect(empty.buckets).toHaveLength(0);

    readerMocks.readTranscriptRecords.mockResolvedValue([record()]);
    const recovered = await service.readSummary(WINDOW);
    expect(readerMocks.readTranscriptRecords).toHaveBeenCalledTimes(2);
    expect(recovered.buckets[0]?.records).toBe(1);
  });

  it("warms a fresh instance from the persisted cache", async () => {
    const service = createService();
    await service.readSummary(WINDOW);
    await service.dispose();

    readerMocks.readTranscriptRecords.mockClear();
    const restarted = createService();
    const summary = await restarted.readSummary(WINDOW);
    expect(readerMocks.readTranscriptRecords).not.toHaveBeenCalled();
    expect(summary.buckets[0]?.records).toBe(1);
  });

  it("reports a provider with no directory as missing, not failed", async () => {
    const summary = await createService().readSummary(WINDOW);
    const codex = summary.sources.find((source) => source.provider === "codex");
    expect(codex?.status).toBe("missing");
    expect(summary.sources.find((s) => s.provider === "claude")?.status).toBe(
      "ok",
    );
  });

  it("leaves everything unpriced when no rate table can be had", async () => {
    const summary = await createService().readSummary(WINDOW);
    expect(summary.pricing).toEqual({
      status: "unavailable",
      fetchedAt: null,
      knownModels: 0,
    });
    expect(summary.buckets[0]?.costSource).toBe("unpriced");
    expect(summary.buckets[0]?.costUsd).toBe(0);
  });

  it("shares one scan between concurrent identical requests", async () => {
    const service = createService();
    const [a, b] = await Promise.all([
      service.readSummary(WINDOW),
      service.readSummary(WINDOW),
    ]);
    expect(readerMocks.readTranscriptRecords).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("honours CLAUDE_CONFIG_DIR when resolving transcripts", async () => {
    const service = createService({
      homeDir: path.join(root, "elsewhere"),
      env: { CLAUDE_CONFIG_DIR: path.join(root, "home", ".claude") },
    });
    const summary = await service.readSummary(WINDOW);
    expect(summary.sources.find((s) => s.provider === "claude")?.origin).toBe(
      claudeProjects,
    );
    expect(summary.buckets).toHaveLength(1);
  });

  describe("cursor", () => {
    const NOW = Date.parse("2026-09-15T12:00:00.000Z");

    function cursorEvent(overrides: Record<string, unknown> = {}) {
      return {
        timestamp: String(Date.parse("2026-09-15T09:00:00.000Z")),
        model: "composer-2.5",
        conversationId: "conv-1",
        chargedCents: 250,
        tokenUsage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 6 },
        ...overrides,
      };
    }

    function cursorFetch(rows: unknown[]) {
      return vi.fn(async (url: string) => {
        if (!url.includes("cursor.sh")) {
          throw new Error("offline");
        }
        return {
          ok: true,
          json: async () => ({
            totalUsageEventsCount: rows.length,
            usageEventsDisplay: rows,
          }),
        };
      });
    }

    function cursorCalls(fetchImpl: ReturnType<typeof cursorFetch>) {
      return fetchImpl.mock.calls.filter(([url]) =>
        String(url).includes("cursor.sh"),
      );
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      readerMocks.readTranscriptRecords.mockResolvedValue([]);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function withCursor(fetchImpl: ReturnType<typeof cursorFetch>) {
      vi.stubGlobal("fetch", fetchImpl);
      return createService({ readCursorAccessToken: async () => "token" });
    }

    it("buckets events with the cost Cursor billed", async () => {
      const summary = await withCursor(
        cursorFetch([cursorEvent()]),
      ).readSummary(WINDOW);

      const bucket = summary.buckets.find((b) => b.provider === "cursor");
      expect(bucket).toMatchObject({
        day: "2026-09-15",
        model: "composer-2.5",
        costSource: "providerReported",
        records: 1,
        sessions: 1,
      });
      expect(bucket?.costUsd).toBeCloseTo(2.5, 10);
      expect(bucket?.totals).toEqual({
        uncachedInputTokens: 10,
        cachedInputTokens: 6,
        cacheCreationTokens: 0,
        outputTokens: 4,
        reasoningTokens: 0,
      });
    });

    it("reports the api source and its session count", async () => {
      const summary = await withCursor(
        cursorFetch([cursorEvent(), cursorEvent({ conversationId: "conv-2" })]),
      ).readSummary(WINDOW);

      expect(
        summary.sources.find((s) => s.provider === "cursor"),
      ).toMatchObject({
        kind: "api",
        status: "ok",
        distinctSessions: 2,
        message: null,
      });
    });

    it("serves the cache instead of refetching inside the ttl", async () => {
      const fetchImpl = cursorFetch([cursorEvent()]);
      const service = withCursor(fetchImpl);

      await service.readSummary(WINDOW);
      expect(cursorCalls(fetchImpl)).toHaveLength(1);

      vi.setSystemTime(NOW + 30_000);
      const again = await service.readSummary(WINDOW);
      expect(cursorCalls(fetchImpl)).toHaveLength(1);
      expect(again.buckets.find((b) => b.provider === "cursor")?.records).toBe(
        1,
      );
    });

    it("refreshes only the trailing edge once the ttl lapses", async () => {
      const fetchImpl = cursorFetch([cursorEvent()]);
      const service = withCursor(fetchImpl);
      await service.readSummary(WINDOW);

      vi.setSystemTime(NOW + 120_000);
      await service.readSummary(WINDOW);

      const calls = cursorCalls(fetchImpl);
      expect(calls).toHaveLength(2);
      const [, secondInit] = calls[1] as unknown as [string, RequestInit];
      const second = JSON.parse(String(secondInit.body));
      expect(Number(second.startDate)).toBeGreaterThan(
        Date.parse("2026-09-15T11:00:00.000Z"),
      );
    });

    it("warms a fresh instance from the persisted event cache", async () => {
      const fetchImpl = cursorFetch([cursorEvent()]);
      const service = withCursor(fetchImpl);
      await service.readSummary(WINDOW);
      await service.dispose();

      const restarted = withCursor(cursorFetch([]));
      const summary = await restarted.readSummary(WINDOW);
      expect(
        summary.buckets.find((b) => b.provider === "cursor")?.records,
      ).toBe(1);
    });

    it("keeps cached events when a refresh fails", async () => {
      const service = withCursor(cursorFetch([cursorEvent()]));
      await service.readSummary(WINDOW);

      vi.setSystemTime(NOW + 120_000);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("offline");
        }),
      );
      const summary = await service.readSummary(WINDOW);

      const source = summary.sources.find((s) => s.provider === "cursor");
      expect(source?.status).toBe("ok");
      expect(source?.message).toMatch(/could not be fetched/);
      expect(
        summary.buckets.find((b) => b.provider === "cursor")?.records,
      ).toBe(1);
    });

    it("marks the source failed when the very first fetch fails", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("offline");
        }),
      );
      const service = createService({
        readCursorAccessToken: async () => "token",
      });
      const summary = await service.readSummary(WINDOW);
      expect(summary.sources.find((s) => s.provider === "cursor")?.status).toBe(
        "failed",
      );
    });

    it("stays quiet and makes no request without a token", async () => {
      const fetchImpl = cursorFetch([cursorEvent()]);
      vi.stubGlobal("fetch", fetchImpl);
      const summary = await createService().readSummary(WINDOW);

      expect(cursorCalls(fetchImpl)).toHaveLength(0);
      expect(
        summary.sources.find((s) => s.provider === "cursor"),
      ).toMatchObject({ status: "unauthenticated", distinctSessions: 0 });
    });

    it("skips the dashboard under api key authentication", async () => {
      const fetchImpl = cursorFetch([cursorEvent()]);
      vi.stubGlobal("fetch", fetchImpl);
      const summary = await createService({
        env: { CURSOR_API_KEY: "key" },
        readCursorAccessToken: async () => "token",
      }).readSummary(WINDOW);

      expect(cursorCalls(fetchImpl)).toHaveLength(0);
      expect(summary.sources.find((s) => s.provider === "cursor")?.status).toBe(
        "unauthenticated",
      );
    });
  });
});
