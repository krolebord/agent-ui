import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../../../src/main/logger", () => ({ default: loggerMocks }));

import { replaceTurnChunks } from "../../../../src/main/session-memory/store/chunks";
import { SessionMemoryDatabase } from "../../../../src/main/session-memory/store/database";
import { applyParseOutcome } from "../../../../src/main/session-memory/store/index-writer";
import {
  createTempDatabase,
  makeConversation,
  makeSource,
  outcomeOf,
} from "./fixtures";

describe("SessionMemoryDatabase", () => {
  let database: SessionMemoryDatabase;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ database, cleanup } = await createTempDatabase());
  });

  afterEach(async () => {
    await cleanup();
  });

  it("creates a private WAL database with the index tables", async () => {
    expect(database.path).toMatch(/session-memory\.sqlite3$/);
    expect((await stat(database.path)).mode & 0o777).toBe(0o600);

    const tables = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `.execute(database.db);
    expect(tables.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "chunks",
        "conversations",
        "sources",
        "turn_chunk_state",
        "turns",
      ]),
    );
    const journal = await sql<{
      journal_mode: string;
    }>`PRAGMA journal_mode`.execute(database.db);
    expect(journal.rows[0]?.journal_mode).toBe("wal");
  });

  it("cascades turn deletion and clears source links when a conversation is removed", async () => {
    const source = makeSource("claude", "/c/abc.jsonl");
    await applyParseOutcome(database.db, {
      source,
      outcome: outcomeOf(makeConversation(source)),
      links: { projectPath: null, agentUiSessionId: null },
      parserVersion: 1,
      now: 1,
    });

    await database.db.deleteFrom("conversations").execute();

    expect(await database.db.selectFrom("turns").selectAll().execute()).toEqual(
      [],
    );
    expect(
      (
        await database.db
          .selectFrom("sources")
          .select("conversation_id")
          .executeTakeFirst()
      )?.conversation_id,
    ).toBeNull();
  });

  it("loads sqlite-vec and cascades chunk rows with their turn", async () => {
    expect(database.vectorSearch).toBe(true);
    const version = await sql<{
      version: string;
    }>`SELECT vec_version() AS version`.execute(database.db);
    expect(version.rows[0]?.version).toMatch(/^v\d/);

    const source = makeSource("claude", "/c/abc.jsonl");
    await applyParseOutcome(database.db, {
      source,
      outcome: outcomeOf(makeConversation(source)),
      links: { projectPath: null, agentUiSessionId: null },
      parserVersion: 1,
      now: 1,
    });
    const turn = await database.db
      .selectFrom("turns")
      .select(["id", "content_hash"])
      .where("ordinal", "=", 0)
      .executeTakeFirstOrThrow();
    await replaceTurnChunks(database.db, {
      turn: { turnId: turn.id, contentHash: turn.content_hash, title: null },
      modelId: "m",
      chunkerVersion: 1,
      now: 1,
      chunks: [{ index: 0, text: "t", tokenCount: 3, embedHash: "h" }],
    });

    await database.db.deleteFrom("turns").where("id", "=", turn.id).execute();

    expect(
      await database.db.selectFrom("chunks").selectAll().execute(),
    ).toEqual([]);
    expect(
      await database.db.selectFrom("turn_chunk_state").selectAll().execute(),
    ).toEqual([]);
  });

  it("still opens without vector search when the extension fails to load", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agent-ui-session-memory-"));
    const opened = await SessionMemoryDatabase.create(dir, {
      loadVectorExtension: () => {
        throw new Error("no extension");
      },
    });
    try {
      expect(opened.vectorSearch).toBe(false);
      expect(
        await opened.db.selectFrom("chunks").selectAll().execute(),
      ).toEqual([]);
    } finally {
      await opened.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
