import * as z from "zod";
import type { UsageRecord } from "./transcripts";

export const CURSOR_USAGE_ENDPOINT =
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetFilteredUsageEvents";

const PAGE_SIZE = 1000;

const MAX_PAGES = 40;

const REQUEST_TIMEOUT_MS = 20_000;

const numeric = z.preprocess((value) => {
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return value;
}, z.number().finite());

const tokenUsageSchema = z.object({
  inputTokens: numeric.optional(),
  outputTokens: numeric.optional(),
  cacheReadTokens: numeric.optional(),
  cacheWriteTokens: numeric.optional(),
});

const usageEventSchema = z.object({
  timestamp: numeric,
  model: z.string().optional(),
  conversationId: z.string().optional(),
  chargedCents: numeric.optional(),
  tokenUsage: tokenUsageSchema.optional(),
});

const responseSchema = z.object({
  totalUsageEventsCount: numeric.optional(),
  usageEventsDisplay: z.array(z.unknown()).optional(),
});

export const UNKNOWN_CURSOR_MODEL = "unknown";

function whole(value: number | undefined): number {
  return value !== undefined && value > 0 ? Math.trunc(value) : 0;
}

export function cursorDedupeKey(
  timestampMs: number,
  sessionId: string,
  model: string,
  costUsd: number,
): string {
  return `${timestampMs}:${sessionId}:${model}:${costUsd}`;
}

export function toUsageRecord(raw: unknown): UsageRecord | null {
  const parsed = usageEventSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }

  const event = parsed.data;
  const timestampMs = Math.trunc(event.timestamp);
  if (timestampMs <= 0) {
    return null;
  }

  const usage = event.tokenUsage;
  const rawModel = event.model?.trim() ?? "";
  const model = rawModel.length === 0 ? UNKNOWN_CURSOR_MODEL : rawModel;
  const sessionId = event.conversationId ?? "";
  const costUsd =
    event.chargedCents === undefined ? 0 : event.chargedCents / 100;

  return {
    provider: "cursor",
    timestampMs,
    model,
    sessionId,
    totals: {
      uncachedInputTokens: whole(usage?.inputTokens),
      cachedInputTokens: whole(usage?.cacheReadTokens),
      cacheCreationTokens: whole(usage?.cacheWriteTokens),
      outputTokens: whole(usage?.outputTokens),
      reasoningTokens: 0,
    },
    dedupeKey: cursorDedupeKey(timestampMs, sessionId, model, costUsd),
    costUsd,
  };
}

export interface FetchCursorUsageOptions {
  accessToken: string;
  startMs: number;
  endMs: number;
  fetchImpl?: typeof fetch;
}

export interface CursorUsagePage {
  records: UsageRecord[];
  pages: number;
}

async function requestPage(
  options: FetchCursorUsageOptions,
  page: number,
): Promise<unknown> {
  const call = options.fetchImpl ?? fetch;
  const response = await call(CURSOR_USAGE_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: JSON.stringify({
      startDate: String(Math.trunc(options.startMs)),
      endDate: String(Math.trunc(options.endMs)),
      page,
      pageSize: PAGE_SIZE,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Cursor usage events returned ${response.status} ${response.statusText}`,
    );
  }
  return await response.json();
}

/**
 * Pages through Cursor's dashboard usage events. `pageSize` is capped at 1000
 * server-side, so a window wider than that needs several round trips.
 */
export async function fetchCursorUsageRecords(
  options: FetchCursorUsageOptions,
): Promise<CursorUsagePage> {
  const records: UsageRecord[] = [];
  let pages = 0;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const parsed = responseSchema.safeParse(await requestPage(options, page));
    pages += 1;
    if (!parsed.success) {
      throw new Error("Cursor usage events response has an unexpected shape");
    }

    const rows = parsed.data.usageEventsDisplay ?? [];
    for (const row of rows) {
      const record = toUsageRecord(row);
      if (record) {
        records.push(record);
      }
    }

    const total = parsed.data.totalUsageEventsCount;
    const exhausted =
      rows.length < PAGE_SIZE ||
      (total !== undefined && page * PAGE_SIZE >= total);
    if (exhausted) {
      break;
    }
  }

  return { records, pages };
}
