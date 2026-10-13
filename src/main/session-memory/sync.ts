import type { SessionMemorySourceStatus } from "@shared/session-memory";
import type { ParseOutcome, TranscriptSource } from "./parsers";
import type { SessionMemoryDb } from "./store/database";
import {
  applyParseOutcome,
  type ConversationLinker,
  loadSourceRecords,
  markSourcesMissing,
  recordSourceFailure,
  relinkConversations,
  resolveConversationLinks,
  type SourceRecord,
} from "./store/index-writer";

export interface SessionMemorySyncOptions {
  db: SessionMemoryDb;
  discover: () => Promise<TranscriptSource[]>;
  parse: (source: TranscriptSource) => Promise<ParseOutcome>;
  linker: ConversationLinker;
  parserVersion: number;
  now: () => number;
  signal?: AbortSignal;
  onProgress?: (progress: { done: number; total: number }) => void;
  yieldToEventLoop?: () => Promise<void>;
}

export interface SessionMemorySyncResult {
  discovered: number;
  processed: number;
  statuses: Partial<Record<SessionMemorySourceStatus, number>>;
  newlyMissing: number;
  relinked: number;
  aborted: boolean;
}

const yieldWithSetImmediate = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

export function sourceNeedsParse(
  source: TranscriptSource,
  record: SourceRecord | undefined,
  parserVersion: number,
): boolean {
  if (source.size === 0 || record?.status === "forgotten") {
    return false;
  }
  return (
    record === undefined ||
    record.fingerprint !== source.fingerprint ||
    record.parserVersion !== parserVersion ||
    record.status === "failed" ||
    record.status === "missing"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One pass: parse sources whose fingerprint or parser version changed, one at
 * a time with a yield in between, then mark vanished sources missing (their
 * conversations stay) and refresh links.
 */
export async function runSessionMemorySync(
  options: SessionMemorySyncOptions,
): Promise<SessionMemorySyncResult> {
  const { db, linker, parserVersion, now, signal } = options;
  const yieldToEventLoop = options.yieldToEventLoop ?? yieldWithSetImmediate;

  const discovered = await options.discover();
  const records = await loadSourceRecords(db);

  const discoveredPaths = new Set(discovered.map((source) => source.path));
  const newlyMissing = [...records.values()]
    .filter(
      (record) =>
        record.status !== "missing" &&
        record.status !== "forgotten" &&
        !discoveredPaths.has(record.path),
    )
    .map((record) => record.path);
  await markSourcesMissing(db, newlyMissing, now());

  const pending = discovered
    .filter((source) =>
      sourceNeedsParse(source, records.get(source.path), parserVersion),
    )
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const result: SessionMemorySyncResult = {
    discovered: discovered.length,
    processed: 0,
    statuses: {},
    newlyMissing: newlyMissing.length,
    relinked: 0,
    aborted: false,
  };
  options.onProgress?.({ done: 0, total: pending.length });

  for (const source of pending) {
    if (signal?.aborted) {
      result.aborted = true;
      break;
    }
    let status: SessionMemorySourceStatus;
    try {
      const outcome = await options.parse(source);
      const links = outcome.conversation
        ? await resolveConversationLinks(linker, outcome.conversation)
        : { projectPath: null, agentUiSessionId: null };
      status = await applyParseOutcome(db, {
        source,
        outcome,
        links,
        parserVersion,
        now: now(),
      });
    } catch (error) {
      await recordSourceFailure(db, {
        source,
        error: errorMessage(error),
        parserVersion,
        now: now(),
      });
      status = "failed";
    }
    result.processed += 1;
    result.statuses[status] = (result.statuses[status] ?? 0) + 1;
    options.onProgress?.({ done: result.processed, total: pending.length });
    await yieldToEventLoop();
  }

  result.relinked = await relinkConversations(db, linker);
  return result;
}
