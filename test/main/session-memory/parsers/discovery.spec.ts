import * as fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TranscriptRoots } from "../../../../src/main/agent-transcripts/roots";
import { discoverTranscriptSources } from "../../../../src/main/session-memory/parsers/discovery";
import { makeTempRoot, writeJson, writeJsonl } from "./fixtures";

let root: string;
let roots: TranscriptRoots;

beforeEach(async () => {
  root = await makeTempRoot("transcript-discovery-");
  roots = {
    claudeProjects: path.join(root, "claude", "projects"),
    codexSessions: path.join(root, "codex", "sessions"),
    cursorProjects: path.join(root, "cursor", "projects"),
    cursorChats: path.join(root, "cursor", "chats"),
  };
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe("discoverTranscriptSources", () => {
  it("finds every agent's transcripts and their side files", async () => {
    const claudeMain = await writeJsonl(
      path.join(roots.claudeProjects, "-work", "sess-1.jsonl"),
      [{}],
    );
    const claudeSub = await writeJsonl(
      path.join(
        roots.claudeProjects,
        "-work",
        "sess-1",
        "subagents",
        "agent-a1.jsonl",
      ),
      [{}],
    );
    const claudeSubMeta = await writeJson(
      path.join(
        roots.claudeProjects,
        "-work",
        "sess-1",
        "subagents",
        "agent-a1.meta.json",
      ),
      { description: "Scan" },
    );
    await writeJsonl(
      path.join(
        roots.claudeProjects,
        "-work",
        "sess-1",
        "tool-results",
        "x.jsonl",
      ),
      [{}],
    );
    const codex = await writeJsonl(
      path.join(
        roots.codexSessions,
        "2026",
        "09",
        "01",
        "rollout-2026-09-01T10-00-00-thr.jsonl",
      ),
      [{}],
    );
    await writeJsonl(
      path.join(roots.codexSessions, "2026", "09", "01", "notes.jsonl"),
      [{}],
    );
    const cursorWithMeta = await writeJsonl(
      path.join(
        roots.cursorProjects,
        "work",
        "agent-transcripts",
        "chat-1",
        "chat-1.jsonl",
      ),
      [{}],
    );
    const cursorMeta = await writeJson(
      path.join(roots.cursorChats, "hash", "chat-1", "meta.json"),
      {
        cwd: "/work",
      },
    );
    const cursorWithoutMeta = await writeJsonl(
      path.join(
        roots.cursorProjects,
        "work",
        "agent-transcripts",
        "chat-2",
        "chat-2.jsonl",
      ),
      [{}],
    );
    await writeJson(
      path.join(roots.cursorChats, "hash", "chat-3", "meta.json"),
      { cwd: "/work" },
    );

    const sources = await discoverTranscriptSources(roots);
    const byPath = new Map(sources.map((source) => [source.path, source]));

    expect([...byPath.keys()].sort()).toEqual(
      [claudeMain, claudeSub, codex, cursorWithMeta, cursorWithoutMeta].sort(),
    );
    expect(byPath.get(claudeMain)).toMatchObject({
      agent: "claude",
      metaPath: null,
    });
    expect(byPath.get(claudeSub)).toMatchObject({
      agent: "claude",
      metaPath: claudeSubMeta,
      metaMtimeMs: expect.any(Number),
    });
    expect(byPath.get(codex)?.agent).toBe("codex");
    expect(byPath.get(cursorWithMeta)).toMatchObject({
      agent: "cursor",
      metaPath: cursorMeta,
    });
    expect(byPath.get(cursorWithoutMeta)).toMatchObject({
      agent: "cursor",
      metaPath: null,
    });
  });

  it("changes the fingerprint when only the side file changes", async () => {
    const filePath = await writeJsonl(
      path.join(
        roots.cursorProjects,
        "work",
        "agent-transcripts",
        "chat-1",
        "chat-1.jsonl",
      ),
      [{}],
    );
    const metaPath = await writeJson(
      path.join(roots.cursorChats, "hash", "chat-1", "meta.json"),
      {},
    );
    const before = (await discoverTranscriptSources(roots)).find(
      (source) => source.path === filePath,
    );

    const later = new Date(Date.now() + 60_000);
    await fsp.utimes(metaPath, later, later);
    const after = (await discoverTranscriptSources(roots)).find(
      (source) => source.path === filePath,
    );

    expect(after?.fingerprint).not.toBe(before?.fingerprint);
  });

  it("returns nothing when no agent has been used", async () => {
    expect(await discoverTranscriptSources(roots)).toEqual([]);
  });
});
