import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageHistoryAggregator } from "../../../src/main/usage-history/aggregation";
import { dedupeWithinFile } from "../../../src/main/usage-history/scan-cache";
import {
  listTranscriptFiles,
  readTranscriptRecords,
} from "../../../src/main/usage-history/transcript-reader";

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(tmpdir(), "usage-reader-"));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

async function write(relativePath: string, lines: unknown[]): Promise<string> {
  const filePath = path.join(root, relativePath);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(
    filePath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );
  return filePath;
}

function assistantBlock(index: number) {
  return {
    type: "assistant",
    timestamp: "2026-09-09T22:00:55.804Z",
    sessionId: "session-1",
    requestId: "req_1",
    message: {
      id: "msg_1",
      model: "claude-opus-5",
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
        output_tokens: 50,
      },
      blockIndex: index,
    },
  };
}

describe("readTranscriptRecords", () => {
  it("counts one Claude message once across its content blocks", async () => {
    const filePath = await write("claude/a.jsonl", [
      { type: "user", message: { content: "hello" } },
      assistantBlock(0),
      assistantBlock(1),
      assistantBlock(2),
    ]);

    const parsed = await readTranscriptRecords(filePath, "claude");
    expect(parsed).toHaveLength(3);

    const kept = dedupeWithinFile(parsed ?? []);
    expect(kept).toHaveLength(1);

    const aggregator = new UsageHistoryAggregator({
      timeZone: "UTC",
      sinceDay: "2026-09-01",
      untilDay: "2026-09-30",
      rates: new Map(),
    });
    for (const record of kept) {
      aggregator.add(record);
    }
    expect(aggregator.finish().buckets[0]?.totals.outputTokens).toBe(50);
  });

  it("de-duplicates the same message seen in two transcripts", async () => {
    const first = await write("claude/a.jsonl", [assistantBlock(0)]);
    const second = await write("claude/b.jsonl", [assistantBlock(0)]);

    const aggregator = new UsageHistoryAggregator({
      timeZone: "UTC",
      sinceDay: "2026-09-01",
      untilDay: "2026-09-30",
      rates: new Map(),
    });
    for (const filePath of [first, second]) {
      for (const record of (await readTranscriptRecords(filePath, "claude")) ??
        []) {
        aggregator.add(record);
      }
    }

    const result = aggregator.finish();
    expect(result.duplicatesDropped).toBe(1);
    expect(result.buckets[0]?.totals.outputTokens).toBe(50);
  });

  it("carries the Codex model across the whole rollout", async () => {
    const filePath = await write("codex/r.jsonl", [
      {
        timestamp: "2026-09-09T20:00:00.000Z",
        type: "session_meta",
        payload: { id: "codex-1" },
      },
      {
        timestamp: "2026-09-09T20:00:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.6-sol" },
      },
      { type: "response_item", payload: { type: "message" } },
      {
        timestamp: "2026-09-09T20:00:05.000Z",
        type: "token_usage_record",
        payload: {
          usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            cache_write_input_tokens: 10,
            output_tokens: 20,
            reasoning_output_tokens: 5,
          },
        },
      },
    ]);

    const parsed = await readTranscriptRecords(filePath, "codex");
    expect(parsed).toEqual([
      {
        provider: "codex",
        timestampMs: Date.parse("2026-09-09T20:00:05.000Z"),
        model: "gpt-5.6-sol",
        sessionId: "codex-1",
        totals: {
          uncachedInputTokens: 50,
          cachedInputTokens: 40,
          cacheCreationTokens: 10,
          outputTokens: 20,
          reasoningTokens: 5,
        },
        dedupeKey: null,
        costUsd: null,
      },
    ]);
  });

  it("survives a malformed line", async () => {
    const filePath = path.join(root, "broken.jsonl");
    await fsp.writeFile(
      filePath,
      `{"usage": not json\n${JSON.stringify(assistantBlock(0))}\n`,
      "utf8",
    );
    expect(await readTranscriptRecords(filePath, "claude")).toHaveLength(1);
  });

  it("reports an unreadable file apart from an empty one", async () => {
    const empty = await write("empty.jsonl", []);
    expect(await readTranscriptRecords(empty, "claude")).toEqual([]);
    expect(
      await readTranscriptRecords(path.join(root, "missing.jsonl"), "claude"),
    ).toBeNull();
  });
});

describe("listTranscriptFiles", () => {
  it("walks nested directories for .jsonl files newer than the cutoff", async () => {
    const recent = await write("2026/09/09/a.jsonl", [assistantBlock(0)]);
    const stale = await write("2026/01/01/b.jsonl", [assistantBlock(0)]);
    await write("2026/09/09/notes.txt", []);
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await fsp.utimes(stale, old, old);

    const found = await listTranscriptFiles(root, Date.now() - 60_000);
    expect(found.map((file) => file.path)).toEqual([recent]);
    expect(found[0]?.size).toBeGreaterThan(0);
  });

  it("reports nothing for a directory that is not there", async () => {
    expect(await listTranscriptFiles(path.join(root, "nope"), 0)).toEqual([]);
  });
});
