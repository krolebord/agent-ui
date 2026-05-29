import type { FSWatcher } from "node:fs";
import { watch } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { defineServiceState } from "@shared/service-state";
import log from "./logger";

export interface HandoffEntry {
  path: string;
  filename: string;
  title: string;
  preview: string;
  createdAt: number;
  size: number;
}

export const defineHandoffsState = () =>
  defineServiceState({
    key: "handoffs",
    defaults: {} as Record<string, HandoffEntry>,
  });

export type HandoffsServiceState = ReturnType<typeof defineHandoffsState>;

const TITLE_PROBE_BYTES = 4096;
const DEBOUNCE_MS = 150;
const PREVIEW_MAX_CHARS = 500;

function deriveTitleFromFilename(filename: string): string {
  const base = filename.replace(/\.md$/i, "");
  const stripped = base.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-?/, "");
  const cleaned = stripped.replace(/[-_]+/g, " ").trim();
  return cleaned || base;
}

function extractTitleFromBody(head: string): string | null {
  const headingMatch = head.match(/^\s*#\s+(.+)$/m);
  if (headingMatch?.[1]) {
    return headingMatch[1].trim();
  }
  return null;
}

// Snippet shown per list row: skip a leading H1 (it's already the title) and
// blank lines, then keep the first few content lines capped at 500 chars.
function buildPreview(head: string): string {
  const lines = head.replace(/^﻿/, "").split("\n");
  let start = 0;
  while (start < lines.length && lines[start]?.trim() === "") start++;
  if (start < lines.length && /^#\s+/.test(lines[start] ?? "")) {
    start++;
    while (start < lines.length && lines[start]?.trim() === "") start++;
  }
  return lines.slice(start).join("\n").trim().slice(0, PREVIEW_MAX_CHARS);
}

async function parseHandoffFile(
  filePath: string,
): Promise<HandoffEntry | null> {
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (!stats.isFile()) return null;

  let head = "";
  try {
    const full = await readFile(filePath, "utf8");
    head = full.slice(0, TITLE_PROBE_BYTES);
  } catch (err) {
    log.warn("Failed to read handoff file for title", { filePath, err });
  }

  const filename = path.basename(filePath);
  const title = extractTitleFromBody(head) ?? deriveTitleFromFilename(filename);

  return {
    path: filePath,
    filename,
    title,
    preview: buildPreview(head),
    createdAt: stats.mtimeMs,
    size: stats.size,
  };
}

export class HandoffsService {
  private watcher: FSWatcher | null = null;
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private disposed = false;

  constructor(
    readonly handoffsDir: string,
    private readonly state: HandoffsServiceState,
  ) {}

  async start(): Promise<void> {
    await this.rescanAll();
    try {
      this.watcher = watch(
        this.handoffsDir,
        { persistent: false },
        (_eventType, filename) => {
          if (!filename || typeof filename !== "string") return;
          if (!filename.toLowerCase().endsWith(".md")) return;
          this.schedule(filename);
        },
      );
      this.watcher.on("error", (err) => {
        log.warn("Handoff watcher error", err);
      });
    } catch (err) {
      log.error("Failed to start handoffs watcher", err);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private schedule(filename: string): void {
    const existing = this.pending.get(filename);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pending.delete(filename);
      void this.refreshOne(filename);
    }, DEBOUNCE_MS);
    this.pending.set(filename, timer);
  }

  private async refreshOne(filename: string): Promise<void> {
    const filePath = path.join(this.handoffsDir, filename);
    let entry: HandoffEntry | null;
    try {
      entry = await parseHandoffFile(filePath);
    } catch (err) {
      log.warn("Failed to refresh handoff entry", { filePath, err });
      return;
    }
    if (this.disposed) return;
    this.state.updateState((entries) => {
      if (entry) {
        entries[filePath] = entry;
      } else {
        delete entries[filePath];
      }
    });
  }

  private async rescanAll(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.handoffsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      log.warn("Failed to read handoffs dir", err);
      return;
    }

    const mdFiles = names.filter((n) => n.toLowerCase().endsWith(".md"));
    const parsed = await Promise.all(
      mdFiles.map((n) =>
        parseHandoffFile(path.join(this.handoffsDir, n)).catch((err) => {
          log.warn("Failed to parse handoff during scan", {
            filename: n,
            err,
          });
          return null;
        }),
      ),
    );

    if (this.disposed) return;
    this.state.updateState((store) => {
      for (const key of Object.keys(store)) delete store[key];
      for (const entry of parsed) {
        if (entry) store[entry.path] = entry;
      }
    });
  }
}
