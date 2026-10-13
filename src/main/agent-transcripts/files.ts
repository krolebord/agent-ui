import type { Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";

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
