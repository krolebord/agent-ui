import { describe, expect, it } from "vitest";
import {
  initialCodexScanState,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  UNKNOWN_CODEX_MODEL,
} from "../../../src/main/usage-history/transcripts";

function claudeBlock(overrides: {
  messageId?: string;
  requestId?: string;
  usage?: Record<string, number>;
}) {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-09-09T22:00:55.804Z",
    sessionId: "session-1",
    requestId: overrides.requestId ?? "req_1",
    message: {
      id: overrides.messageId ?? "msg_1",
      model: "claude-opus-5",
      usage: overrides.usage ?? {
        input_tokens: 2,
        cache_creation_input_tokens: 9983,
        cache_read_input_tokens: 0,
        output_tokens: 1,
      },
    },
  });
}

describe("parseClaudeLine", () => {
  it("reads usage and builds the message/request dedupe key", () => {
    expect(parseClaudeLine(claudeBlock({}))).toEqual({
      provider: "claude",
      timestampMs: Date.parse("2026-09-09T22:00:55.804Z"),
      model: "claude-opus-5",
      sessionId: "session-1",
      totals: {
        uncachedInputTokens: 2,
        cachedInputTokens: 0,
        cacheCreationTokens: 9983,
        outputTokens: 1,
        reasoningTokens: 0,
      },
      dedupeKey: "msg_1:req_1",
      costUsd: null,
    });
  });

  it("gives every content block of one message the same dedupe key", () => {
    const first = parseClaudeLine(claudeBlock({}));
    const second = parseClaudeLine(claudeBlock({}));
    expect(first?.dedupeKey).toBe(second?.dedupeKey);
    expect(first?.totals).toEqual(second?.totals);
  });

  it("falls back to whichever half of the key exists", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-09T22:00:55.804Z",
      message: { id: "msg_2", model: "claude-opus-5", usage: {} },
    });
    expect(parseClaudeLine(line)?.dedupeKey).toBe("msg_2:");
  });

  it("reports no key when neither id is present", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-09T22:00:55.804Z",
      message: { model: "claude-opus-5", usage: { output_tokens: 5 } },
    });
    expect(parseClaudeLine(line)?.dedupeKey).toBeNull();
  });

  it("ignores lines that are not assistant turns with usage", () => {
    expect(parseClaudeLine("not json")).toBeNull();
    expect(parseClaudeLine(JSON.stringify({ type: "user" }))).toBeNull();
    expect(
      parseClaudeLine(
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-09-09T22:00:55.804Z",
          message: { id: "m", model: "claude-opus-5" },
        }),
      ),
    ).toBeNull();
  });
});

function turnContext(model: string, timestamp = "2026-09-09T20:00:00.000Z") {
  return JSON.stringify({
    timestamp,
    type: "turn_context",
    payload: { model },
  });
}

function tokenUsageRecord(
  usage: Record<string, number>,
  timestamp = "2026-09-09T20:48:35.052Z",
) {
  return JSON.stringify({
    timestamp,
    type: "token_usage_record",
    payload: { session_id: "codex-1", usage },
  });
}

function tokenCountEvent(
  usage: Record<string, number>,
  timestamp = "2026-09-09T20:48:35.052Z",
) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: { type: "token_count", info: { last_token_usage: usage } },
  });
}

const USAGE = {
  input_tokens: 96022,
  cached_input_tokens: 11904,
  cache_write_input_tokens: 100,
  output_tokens: 115,
  reasoning_output_tokens: 40,
};

describe("parseCodexLine", () => {
  it("subtracts the cached and written portions from inclusive input", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext("gpt-5.6-sol"), state);
    const record = parseCodexLine(tokenUsageRecord(USAGE), state);

    expect(record?.model).toBe("gpt-5.6-sol");
    expect(record?.totals).toEqual({
      uncachedInputTokens: 96022 - 11904 - 100,
      cachedInputTokens: 11904,
      cacheCreationTokens: 100,
      outputTokens: 115,
      reasoningTokens: 40,
    });
  });

  it("reads the older token_count shape identically", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext("gpt-5.6-sol"), state);
    const record = parseCodexLine(tokenCountEvent(USAGE), state);

    expect(record?.totals.uncachedInputTokens).toBe(96022 - 11904 - 100);
    expect(record?.totals.reasoningTokens).toBe(40);
  });

  it("clamps reasoning tokens to the output they are reported inside", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext("gpt-5.6-sol"), state);
    const record = parseCodexLine(
      tokenUsageRecord({
        ...USAGE,
        output_tokens: 10,
        reasoning_output_tokens: 99,
      }),
      state,
    );
    expect(record?.totals.reasoningTokens).toBe(10);
  });

  it("counts a delta once when both line shapes report it", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext("gpt-5.6-sol"), state);

    expect(parseCodexLine(tokenUsageRecord(USAGE), state)).not.toBeNull();
    expect(
      parseCodexLine(tokenCountEvent(USAGE, "2026-09-09T20:48:35.300Z"), state),
    ).toBeNull();
  });

  it("skips an unchanged consecutive delta but not a later distinct one", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext("gpt-5.6-sol"), state);

    expect(parseCodexLine(tokenUsageRecord(USAGE), state)).not.toBeNull();
    expect(parseCodexLine(tokenUsageRecord(USAGE), state)).toBeNull();
    expect(
      parseCodexLine(tokenUsageRecord({ ...USAGE, output_tokens: 200 }), state),
    ).not.toBeNull();
  });

  it("suppresses the fork-copy burst and resumes at the first real turn", () => {
    const state = initialCodexScanState();
    parseCodexLine(
      JSON.stringify({
        timestamp: "2026-09-09T12:00:00.000Z",
        type: "session_meta",
        payload: { id: "child", forked_from_id: "parent" },
      }),
      state,
    );
    parseCodexLine(
      turnContext("gpt-5.6-sol", "2026-09-09T12:00:00.010Z"),
      state,
    );

    expect(
      parseCodexLine(
        tokenUsageRecord(
          { ...USAGE, output_tokens: 1 },
          "2026-09-09T12:00:00.020Z",
        ),
        state,
      ),
    ).toBeNull();
    expect(
      parseCodexLine(
        tokenUsageRecord(
          { ...USAGE, output_tokens: 2 },
          "2026-09-09T12:00:00.050Z",
        ),
        state,
      ),
    ).toBeNull();

    const own = parseCodexLine(
      tokenUsageRecord(
        { ...USAGE, output_tokens: 3 },
        "2026-09-09T12:00:06.000Z",
      ),
      state,
    );
    expect(own).not.toBeNull();
    expect(own?.sessionId).toBe("child");
  });

  it("keeps the session id from the first meta only", () => {
    const state = initialCodexScanState();
    parseCodexLine(
      JSON.stringify({
        timestamp: "2026-09-09T12:00:00.000Z",
        type: "session_meta",
        payload: { id: "own" },
      }),
      state,
    );
    parseCodexLine(
      JSON.stringify({
        timestamp: "2026-09-09T12:00:00.001Z",
        type: "session_meta",
        payload: { id: "ancestor" },
      }),
      state,
    );
    parseCodexLine(turnContext("gpt-5.6-sol"), state);
    expect(parseCodexLine(tokenUsageRecord(USAGE), state)?.sessionId).toBe(
      "own",
    );
  });

  it("carries a model switch forward from the turn that made it", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext("gpt-5.6-sol"), state);
    expect(parseCodexLine(tokenUsageRecord(USAGE), state)?.model).toBe(
      "gpt-5.6-sol",
    );
    parseCodexLine(turnContext("gpt-6-astra"), state);
    expect(
      parseCodexLine(tokenUsageRecord({ ...USAGE, output_tokens: 7 }), state)
        ?.model,
    ).toBe("gpt-6-astra");
  });

  it("reports an unnamed model rather than dropping its tokens", () => {
    const state = initialCodexScanState();
    expect(parseCodexLine(tokenUsageRecord(USAGE), state)?.model).toBe(
      UNKNOWN_CODEX_MODEL,
    );
  });

  it("drops a delta with no tokens at all", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext("gpt-5.6-sol"), state);
    expect(
      parseCodexLine(
        tokenUsageRecord({
          input_tokens: 0,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
        }),
        state,
      ),
    ).toBeNull();
  });
});

describe("mightCarryUsage", () => {
  it("admits both Codex line shapes and rejects ordinary output", () => {
    expect(mightCarryUsage('{"type":"token_usage_record"}', "codex")).toBe(
      true,
    );
    expect(mightCarryUsage('{"type":"token_count"}', "codex")).toBe(true);
    expect(mightCarryUsage('{"type":"response_item"}', "codex")).toBe(false);
    expect(mightCarryUsage('{"usage":{}}', "claude")).toBe(true);
    expect(mightCarryUsage('{"type":"user"}', "claude")).toBe(false);
  });
});
