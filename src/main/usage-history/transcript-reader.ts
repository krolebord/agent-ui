import { createReadStream, type Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { UsageHistoryProvider } from "@shared/usage-history";
import {
  initialCodexScanState,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  type UsageRecord,
} from "./transcripts";

export interface TranscriptFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export async function listTranscriptFiles(
  root: string,
  sinceMs: number,
): Promise<TranscriptFile[]> {
  const found: TranscriptFile[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) {
        continue;
      }
      try {
        const stats = await fsp.stat(child);
        if (stats.mtimeMs >= sinceMs) {
          found.push({ path: child, size: stats.size, mtimeMs: stats.mtimeMs });
        }
      } catch {}
    }
  };

  await walk(root);
  return found;
}

export async function readTranscriptRecords(
  filePath: string,
  provider: UsageHistoryProvider,
): Promise<UsageRecord[] | null> {
  const codexState = initialCodexScanState();
  const records: UsageRecord[] = [];

  const parseLine = (line: string): void => {
    if (provider === "codex") {
      if (
        !mightCarryUsage(line, provider) &&
        !line.includes('"turn_context"') &&
        !line.includes('"session_meta"')
      ) {
        return;
      }
      const record = parseCodexLine(line, codexState);
      if (record) {
        records.push(record);
      }
      return;
    }
    if (!mightCarryUsage(line, provider)) {
      return;
    }
    const record = parseClaudeLine(line);
    if (record) {
      records.push(record);
    }
  };

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  try {
    for await (const line of lines) {
      parseLine(line);
    }
  } catch {
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }

  return records;
}
