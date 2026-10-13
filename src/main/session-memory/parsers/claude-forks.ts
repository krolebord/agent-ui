import type { Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import { asString, parseJsonRecord } from "../../agent-transcripts/json";
import { forEachLine } from "../../agent-transcripts/jsonl";

/**
 * Tracks the message lines that open a Claude transcript, up to the first line
 * without a uuid. A live session writes bookkeeping lines (`last-prompt`,
 * `permission-mode`, ...) after its first turn, while `--fork-session` copies
 * the parent's whole active branch in one contiguous block that keeps the
 * original uuids.
 */
export class LeadingRun {
  readonly uuids: string[] = [];
  private closed = false;

  /** Returns false once the run has ended. */
  add(record: Record<string, unknown>): boolean {
    if (this.closed) {
      return false;
    }
    const uuid = asString(record.uuid);
    if (uuid !== null && record.isSidechain !== true) {
      this.uuids.push(uuid);
    } else if (this.uuids.length > 0) {
      this.closed = true;
    }
    return !this.closed;
  }
}

async function readLeadingRunPrefix(
  filePath: string,
  expected: readonly string[],
): Promise<number> {
  const run = new LeadingRun();
  let matches = true;
  await forEachLine(filePath, (line) => {
    const record = line.trim() ? parseJsonRecord(line) : null;
    if (record === null) {
      return true;
    }
    const open = run.add(record);
    const index = run.uuids.length - 1;
    if (open && index >= 0 && run.uuids[index] !== expected[index]) {
      matches = false;
    }
    return open && matches && run.uuids.length < expected.length;
  });
  return matches ? run.uuids.length : 0;
}

export interface ClaudeForkParent {
  nativeId: string;
  /** Uuids of the opening run that were copied from the parent. */
  copiedUuids: Set<string>;
}

async function readFirstUuid(filePath: string): Promise<string | null> {
  let first: string | null = null;
  await forEachLine(filePath, (line) => {
    const record = line.trim() ? parseJsonRecord(line) : null;
    if (record !== null && record.isSidechain !== true) {
      first = asString(record.uuid);
    }
    return first === null;
  });
  return first;
}

async function collectCopiedUuids(
  parentPath: string,
  leadingRun: readonly string[],
): Promise<Set<string>> {
  const wanted = new Set(leadingRun);
  const copied = new Set<string>();
  await forEachLine(parentPath, (line) => {
    const uuid = line.includes('"uuid"')
      ? asString(parseJsonRecord(line)?.uuid)
      : null;
    if (uuid !== null && wanted.has(uuid)) {
      copied.add(uuid);
    }
  });
  return copied;
}

/**
 * Finds the transcript in the same project directory whose own opening run is
 * a strict prefix of this one: the fork's copied block extends past the
 * parent's first turn. Among nested forks the longest match is the direct
 * parent. A parent forked right after its only turn is not detected.
 *
 * Keep one instance per service: it caches each transcript's first message
 * uuid, which never changes once written.
 */
export class ClaudeForkFinder {
  private readonly firstUuids = new Map<string, string>();

  async find(
    transcriptPath: string,
    leadingRun: readonly string[],
  ): Promise<ClaudeForkParent | null> {
    if (leadingRun.length < 2) {
      return null;
    }
    const dir = path.dirname(transcriptPath);
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    let parent: { path: string; runLength: number } | null = null;
    for (const entry of entries) {
      const candidate = path.join(dir, entry.name);
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".jsonl") ||
        candidate === transcriptPath ||
        (await this.firstUuid(candidate)) !== leadingRun[0]
      ) {
        continue;
      }
      const runLength = await readLeadingRunPrefix(candidate, leadingRun).catch(
        () => 0,
      );
      if (
        runLength > 0 &&
        runLength < leadingRun.length &&
        runLength > (parent?.runLength ?? 0)
      ) {
        parent = { path: candidate, runLength };
      }
    }
    if (parent === null) {
      return null;
    }
    try {
      return {
        nativeId: path.basename(parent.path, ".jsonl"),
        copiedUuids: await collectCopiedUuids(parent.path, leadingRun),
      };
    } catch {
      return null;
    }
  }

  private async firstUuid(filePath: string): Promise<string | null> {
    const cached = this.firstUuids.get(filePath);
    if (cached !== undefined) {
      return cached;
    }
    const first = await readFirstUuid(filePath).catch(() => null);
    if (first !== null) {
      this.firstUuids.set(filePath, first);
    }
    return first;
  }
}
