import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CachedFile,
  decodeScanCache,
  dedupeWithinFile,
  encodeScanCache,
  pruneScanCache,
  type ScanCache,
} from "../../../src/main/usage-history/scan-cache";
import type { UsageRecord } from "../../../src/main/usage-history/transcripts";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    timestampMs: 1_757_000_000_000,
    model: "claude-opus-5",
    sessionId: "session-1",
    totals: {
      uncachedInputTokens: 1,
      cachedInputTokens: 2,
      cacheCreationTokens: 3,
      outputTokens: 4,
      reasoningTokens: 0,
    },
    dedupeKey: "msg_1:req_1",
    costUsd: null,
    ...overrides,
  };
}

function entry(overrides: Partial<CachedFile> = {}): CachedFile {
  return {
    size: 100,
    mtimeMs: 1_757_000_000_000,
    provider: "claude",
    records: [record()],
    ...overrides,
  };
}

type Encoded = ReturnType<typeof encodeScanCache>;

function corrupt(
  encoded: Encoded,
  filePath: string,
  overrides: Partial<Encoded["files"][string]>,
): void {
  const existing = encoded.files[filePath];
  if (existing === undefined) {
    throw new Error(`No serialised entry for ${filePath}`);
  }
  encoded.files[filePath] = { ...existing, ...overrides };
}

describe("scan cache round trip", () => {
  it("restores every record through the interned form", () => {
    const cache: ScanCache = new Map([
      ["/a.jsonl", entry()],
      [
        "/b.jsonl",
        entry({
          provider: "codex",
          records: [
            record({
              provider: "codex",
              model: "gpt-5.6-sol",
              dedupeKey: null,
            }),
          ],
        }),
      ],
    ]);

    const decoded = decodeScanCache(
      JSON.parse(JSON.stringify(encodeScanCache(cache))),
    );
    expect(decoded).toEqual(cache);
  });

  it("interns the repeated model and session ids", () => {
    const cache: ScanCache = new Map([
      ["/a.jsonl", entry({ records: [record(), record({ dedupeKey: "b" })] })],
    ]);
    const encoded = encodeScanCache(cache);
    expect(encoded.models).toEqual(["claude-opus-5"]);
    expect(encoded.sessions).toEqual(["session-1"]);
  });

  it("decodes a corrupt document to an empty cache", () => {
    expect(decodeScanCache(null).size).toBe(0);
    expect(decodeScanCache("nonsense").size).toBe(0);
    expect(
      decodeScanCache({ version: 999, models: [], sessions: [], files: {} })
        .size,
    ).toBe(0);
  });

  it("rejects the whole cache when an intern table is not all strings", () => {
    const encoded = encodeScanCache(new Map([["/a.jsonl", entry()]]));
    expect(
      decodeScanCache({ ...encoded, models: [42] as unknown as string[] }).size,
    ).toBe(0);
  });

  it("drops only the entry whose rows are corrupt", () => {
    const encoded = encodeScanCache(
      new Map([
        ["/good.jsonl", entry()],
        ["/bad.jsonl", entry()],
      ]),
    );
    corrupt(encoded, "/bad.jsonl", { r: [[1, 0] as never] });

    const decoded = decodeScanCache(encoded);
    expect([...decoded.keys()]).toEqual(["/good.jsonl"]);
  });

  it("drops an entry with an unknown provider or missing stats", () => {
    const encoded = encodeScanCache(
      new Map([
        ["/wrong-provider.jsonl", entry()],
        ["/no-size.jsonl", entry()],
      ]),
    );
    corrupt(encoded, "/wrong-provider.jsonl", { p: "gemini" as never });
    corrupt(encoded, "/no-size.jsonl", { s: undefined as never });
    expect(decodeScanCache(encoded).size).toBe(0);
  });
});

describe("pruneScanCache", () => {
  const root = path.join(path.sep, "transcripts");
  const inside = path.join(root, "a.jsonl");
  const elsewhere = path.join(path.sep, "other", "b.jsonl");

  it("removes a walked file that is gone", () => {
    const cache: ScanCache = new Map([[inside, entry({ mtimeMs: 2000 })]]);
    expect(
      pruneScanCache(cache, {
        livePaths: new Set(),
        walkedRoots: [root],
        windowStartMs: 1000,
        retentionCutoffMs: 0,
      }),
    ).toBe(1);
    expect(cache.size).toBe(0);
  });

  it("keeps entries the walk never looked for", () => {
    const cache: ScanCache = new Map([
      [inside, entry({ mtimeMs: 500 })],
      [elsewhere, entry({ mtimeMs: 2000 })],
    ]);
    expect(
      pruneScanCache(cache, {
        livePaths: new Set(),
        walkedRoots: [root],
        windowStartMs: 1000,
        retentionCutoffMs: 0,
      }),
    ).toBe(0);
    expect(cache.size).toBe(2);
  });

  it("drops entries past the retention cutoff wherever they live", () => {
    const cache: ScanCache = new Map([[elsewhere, entry({ mtimeMs: 100 })]]);
    expect(
      pruneScanCache(cache, {
        livePaths: new Set(),
        walkedRoots: [],
        windowStartMs: 0,
        retentionCutoffMs: 1000,
      }),
    ).toBe(1);
  });
});

describe("dedupeWithinFile", () => {
  it("keeps the first record per key and every keyless one", () => {
    const kept = dedupeWithinFile([
      record({ dedupeKey: "a" }),
      record({ dedupeKey: "a" }),
      record({ dedupeKey: null }),
      record({ dedupeKey: null }),
    ]);
    expect(kept).toHaveLength(3);
  });
});
