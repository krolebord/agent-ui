import {
  totalUsageTokens,
  type UsageHistoryProvider,
  type UsageTokenTotals,
} from "@shared/usage-history";

export interface UsageRecord {
  provider: UsageHistoryProvider;
  timestampMs: number;
  model: string;
  sessionId: string;
  totals: UsageTokenTotals;
  dedupeKey: string | null;
  /** Cost billed by the provider. When null the rate table prices the record. */
  costUsd: number | null;
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function mightCarryUsage(
  line: string,
  provider: UsageHistoryProvider,
): boolean {
  if (provider === "claude") {
    return line.includes('"usage"');
  }
  return (
    line.includes('"token_count"') || line.includes('"token_usage_record"')
  );
}

export function parseClaudeLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  const record = asRecord(parsed);
  if (record?.type !== "assistant") {
    return null;
  }

  const message = asRecord(record.message);
  const usage = message === null ? null : asRecord(message.usage);
  if (message === null || usage === null) {
    return null;
  }

  const timestampMs = parseTimestampMs(record.timestamp);
  if (timestampMs === null) {
    return null;
  }

  const model = typeof message.model === "string" ? message.model : "";
  if (model.length === 0) {
    return null;
  }

  const messageId = typeof message.id === "string" ? message.id : null;
  const requestId =
    typeof record.requestId === "string" ? record.requestId : null;
  const dedupeKey =
    messageId === null && requestId === null
      ? null
      : `${messageId ?? ""}:${requestId ?? ""}`;

  return {
    provider: "claude",
    timestampMs,
    model,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
    totals: {
      uncachedInputTokens: int(usage.input_tokens),
      cachedInputTokens: int(usage.cache_read_input_tokens),
      cacheCreationTokens: int(usage.cache_creation_input_tokens),
      outputTokens: int(usage.output_tokens),
      reasoningTokens: 0,
    },
    dedupeKey,
    costUsd: null,
  };
}

export interface CodexScanState {
  model: string;
  sessionId: string;
  lastUsageSignature: string | null;
  sawSessionMeta: boolean;
  suppressingForkCopies: boolean;
  forkCopyAnchorMs: number;
}

export function initialCodexScanState(): CodexScanState {
  return {
    model: "",
    sessionId: "",
    lastUsageSignature: null,
    sawSessionMeta: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
  };
}

export const UNKNOWN_CODEX_MODEL = "unknown";

const FORK_COPY_MAX_GAP_MS = 1000;

function isForkedSessionMeta(payload: Record<string, unknown>): boolean {
  if (typeof payload.forked_from_id === "string") {
    return true;
  }
  const subagent = asRecord(asRecord(payload.source)?.subagent);
  const spawn = asRecord(subagent?.thread_spawn);
  return typeof spawn?.parent_thread_id === "string";
}

interface CodexUsageFields {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  cache_write_input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_output_tokens?: unknown;
}

function readCodexUsageDelta(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
): CodexUsageFields | null {
  if (record.type === "token_usage_record") {
    return asRecord(payload.usage);
  }
  if (payload.type !== "token_count") {
    return null;
  }
  return asRecord(asRecord(payload.info)?.last_token_usage);
}

export function parseCodexLine(
  line: string,
  state: CodexScanState,
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  const record = asRecord(parsed);
  const payload = record && asRecord(record.payload);
  if (!record || !payload) {
    return null;
  }

  if (record.type === "session_meta") {
    if (state.sawSessionMeta) {
      return null;
    }
    state.sawSessionMeta = true;
    const id = payload.id ?? payload.session_id;
    if (typeof id === "string") {
      state.sessionId = id;
    }
    if (typeof payload.model === "string" && state.model.length === 0) {
      state.model = payload.model;
    }
    const metaTimestampMs = parseTimestampMs(record.timestamp);
    if (metaTimestampMs !== null && isForkedSessionMeta(payload)) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = metaTimestampMs;
    }
    return null;
  }

  if (record.type === "turn_context") {
    if (typeof payload.model === "string") {
      state.model = payload.model;
    }
    return null;
  }

  const usage = readCodexUsageDelta(record, payload);
  if (!usage) {
    return null;
  }

  const timestampMs = parseTimestampMs(record.timestamp);
  if (timestampMs === null) {
    return null;
  }

  const inputTokens = int(usage.input_tokens);
  const cachedInputTokens = int(usage.cached_input_tokens);
  const cacheCreationTokens = int(usage.cache_write_input_tokens);
  const outputTokens = int(usage.output_tokens);

  const signature = `${inputTokens}:${cachedInputTokens}:${cacheCreationTokens}:${outputTokens}:${int(usage.reasoning_output_tokens)}`;
  if (signature === state.lastUsageSignature) {
    return null;
  }
  state.lastUsageSignature = signature;

  if (state.suppressingForkCopies) {
    if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
      state.forkCopyAnchorMs = timestampMs;
      return null;
    }
    state.suppressingForkCopies = false;
  }

  const totals: UsageTokenTotals = {
    uncachedInputTokens: Math.max(
      0,
      inputTokens - cachedInputTokens - cacheCreationTokens,
    ),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, int(usage.reasoning_output_tokens)),
  };

  if (totalUsageTokens(totals) === 0) {
    return null;
  }

  return {
    provider: "codex",
    timestampMs,
    model: state.model.length === 0 ? UNKNOWN_CODEX_MODEL : state.model,
    sessionId: state.sessionId,
    totals,
    dedupeKey: null,
    costUsd: null,
  };
}
