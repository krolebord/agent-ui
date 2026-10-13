import type { Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import {
  listTranscriptFiles,
  type TranscriptFile,
} from "../../agent-transcripts/files";
import type { TranscriptRoots } from "../../agent-transcripts/roots";
import type { TranscriptAgent, TranscriptSource } from "./types";

async function readDirs(dir: string): Promise<Dirent[]> {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true })).filter((entry) =>
      entry.isDirectory(),
    );
  } catch {
    return [];
  }
}

async function statFile(
  filePath: string,
): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const stats = await fsp.stat(filePath);
    return stats.isFile() ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
  } catch {
    return null;
  }
}

async function toSource(
  agent: TranscriptAgent,
  file: TranscriptFile,
  metaPath: string | null,
): Promise<TranscriptSource> {
  const meta = metaPath === null ? null : await statFile(metaPath);
  return {
    agent,
    path: file.path,
    size: file.size,
    mtimeMs: file.mtimeMs,
    metaPath: meta === null ? null : metaPath,
    metaMtimeMs: meta?.mtimeMs ?? null,
    fingerprint: [file.size, file.mtimeMs, meta?.mtimeMs ?? ""].join(":"),
  };
}

/** `<slug>/<id>.jsonl` sessions and `<slug>/<id>/subagents/agent-*.jsonl` subagents. */
async function discoverClaude(root: string): Promise<TranscriptSource[]> {
  const sources: TranscriptSource[] = [];
  for (const file of await listTranscriptFiles(root, 0)) {
    const parts = path.relative(root, file.path).split(path.sep);
    if (parts.length === 2) {
      sources.push(await toSource("claude", file, null));
    } else if (
      parts.length === 4 &&
      parts[2] === "subagents" &&
      parts[3]?.startsWith("agent-")
    ) {
      sources.push(
        await toSource(
          "claude",
          file,
          file.path.replace(/\.jsonl$/, ".meta.json"),
        ),
      );
    }
  }
  return sources;
}

async function discoverCodex(root: string): Promise<TranscriptSource[]> {
  const sources: TranscriptSource[] = [];
  for (const file of await listTranscriptFiles(root, 0)) {
    if (path.basename(file.path).startsWith("rollout-")) {
      sources.push(await toSource("codex", file, null));
    }
  }
  return sources;
}

async function indexCursorChatMeta(
  chatsRoot: string,
): Promise<Map<string, string>> {
  const metaPaths = new Map<string, string>();
  for (const workspace of await readDirs(chatsRoot)) {
    const workspaceDir = path.join(chatsRoot, workspace.name);
    for (const chat of await readDirs(workspaceDir)) {
      metaPaths.set(chat.name, path.join(workspaceDir, chat.name, "meta.json"));
    }
  }
  return metaPaths;
}

/** `projects/<slug>/agent-transcripts/<id>/<id>.jsonl`, joined with `chats/<hash>/<id>/meta.json`. */
async function discoverCursor(
  projectsRoot: string,
  chatsRoot: string,
): Promise<TranscriptSource[]> {
  const metaPaths = await indexCursorChatMeta(chatsRoot);
  const sources: TranscriptSource[] = [];
  for (const project of await readDirs(projectsRoot)) {
    const transcriptsDir = path.join(
      projectsRoot,
      project.name,
      "agent-transcripts",
    );
    for (const chat of await readDirs(transcriptsDir)) {
      const filePath = path.join(
        transcriptsDir,
        chat.name,
        `${chat.name}.jsonl`,
      );
      const stats = await statFile(filePath);
      if (stats === null) {
        continue;
      }
      sources.push(
        await toSource(
          "cursor",
          { path: filePath, ...stats },
          metaPaths.get(chat.name) ?? null,
        ),
      );
    }
  }
  return sources;
}

export async function discoverTranscriptSources(
  roots: TranscriptRoots,
): Promise<TranscriptSource[]> {
  const [claude, codex, cursor] = await Promise.all([
    discoverClaude(roots.claudeProjects),
    discoverCodex(roots.codexSessions),
    discoverCursor(roots.cursorProjects, roots.cursorChats),
  ]);
  return [...claude, ...codex, ...cursor];
}
