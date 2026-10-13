import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ParsedConversation,
  TranscriptSource,
} from "../../../../src/main/session-memory/parsers/types";
import { replaceTurnChunks } from "../../../../src/main/session-memory/store/chunks";
import type { SessionMemoryDatabase } from "../../../../src/main/session-memory/store/database";
import {
  clearIndex,
  forgetConversation,
  listForgottenConversations,
  readClearIndexPreview,
  restoreForgottenConversation,
  vacuumDatabase,
} from "../../../../src/main/session-memory/store/forgetting";
import {
  applyParseOutcome,
  markSourcesMissing,
} from "../../../../src/main/session-memory/store/index-writer";
import { getConversation } from "../../../../src/main/session-memory/store/queries";
import {
  createTempDatabase,
  makeConversation,
  makeSource,
  makeTurn,
  outcomeOf,
} from "./fixtures";

describe("forgetting and clearing the session memory index", () => {
  let database: SessionMemoryDatabase;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ database, cleanup } = await createTempDatabase());
  });

  afterEach(async () => {
    await cleanup();
  });

  async function index(
    source: TranscriptSource,
    overrides: Partial<ParsedConversation> = {},
  ): Promise<number> {
    await applyParseOutcome(database.db, {
      source,
      outcome: outcomeOf(makeConversation(source, overrides)),
      links: { projectPath: null, agentUiSessionId: null },
      parserVersion: 1,
      now: 1,
    });
    const conversation = await getConversation(database.db, {
      agent: source.agent,
      nativeId: overrides.nativeId ?? path.basename(source.path, ".jsonl"),
    });
    if (!conversation) throw new Error("not indexed");
    const turns = await database.db
      .selectFrom("turns")
      .select(["id", "content_hash"])
      .where("conversation_id", "=", conversation.id)
      .execute();
    for (const turn of turns) {
      await replaceTurnChunks(database.db, {
        turn: { turnId: turn.id, contentHash: turn.content_hash, title: null },
        modelId: "m",
        chunkerVersion: 1,
        now: 1,
        chunks: [
          {
            index: 0,
            text: `chunk of ${turn.id}`,
            embedHash: `h${turn.id}`,
            tokenCount: 3,
          },
        ],
      });
    }
    return conversation.id;
  }

  async function count(
    table: "conversations" | "turns" | "chunks" | "turn_chunk_state",
  ) {
    const row = await database.db
      .selectFrom(table)
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async function seedFamily() {
    const parent = await index(makeSource("claude", "/c/parent.jsonl"), {
      title: "Rotate the keys",
    });
    const subagent = await index(
      makeSource("claude", "/c/parent/subagents/agent-a.jsonl"),
      { relation: "subagent", parentNativeId: "parent" },
    );
    const nested = await index(
      makeSource("claude", "/c/parent/subagents/agent-b.jsonl"),
      { relation: "subagent", parentNativeId: "agent-a" },
    );
    const fork = await index(makeSource("claude", "/c/fork.jsonl"), {
      relation: "fork",
      parentNativeId: "parent",
    });
    await database.db
      .updateTable("conversations")
      .set({ parent_conversation_id: parent })
      .where("id", "=", fork)
      .execute();
    const other = await index(makeSource("claude", "/c/other.jsonl"));
    return { parent, subagent, nested, fork, other };
  }

  it("deletes the conversation with its subagents, turns and chunks but keeps forks", async () => {
    const ids = await seedFamily();
    expect(await count("conversations")).toBe(5);

    const result = await forgetConversation(database.db, {
      id: ids.parent,
      now: 50,
    });

    expect(result).toEqual({
      agent: "claude",
      nativeId: "parent",
      deletedConversationIds: [ids.parent, ids.subagent, ids.nested],
    });
    const remaining = await database.db
      .selectFrom("conversations")
      .select(["id", "parent_conversation_id"])
      .orderBy("id")
      .execute();
    expect(remaining).toEqual([
      { id: ids.fork, parent_conversation_id: null },
      { id: ids.other, parent_conversation_id: null },
    ]);
    expect(await count("turns")).toBe(4);
    expect(await count("chunks")).toBe(4);
    expect(await count("turn_chunk_state")).toBe(4);
    expect(await listForgottenConversations(database.db)).toEqual([
      {
        agent: "claude",
        nativeId: "parent",
        label: "Rotate the keys",
        forgottenAt: 50,
      },
    ]);
    const sources = await database.db
      .selectFrom("sources")
      .select([
        "path",
        "status",
        "fingerprint",
        "forgotten_native_id",
        "conversation_id",
      ])
      .where("status", "=", "forgotten")
      .orderBy("path")
      .execute();
    expect(sources).toEqual([
      {
        path: "/c/parent.jsonl",
        status: "forgotten",
        fingerprint: "1:1",
        forgotten_native_id: "parent",
        conversation_id: null,
      },
      {
        path: "/c/parent/subagents/agent-a.jsonl",
        status: "forgotten",
        fingerprint: "1:1",
        forgotten_native_id: "parent",
        conversation_id: null,
      },
      {
        path: "/c/parent/subagents/agent-b.jsonl",
        status: "forgotten",
        fingerprint: "1:1",
        forgotten_native_id: "parent",
        conversation_id: null,
      },
    ]);
  });

  it("labels untitled conversations by their opening message and scrubs the text from the file", async () => {
    const id = await index(makeSource("codex", "/x/secret.jsonl"), {
      turns: [
        makeTurn(0, {
          userText: `  my token is   sk-SECRET-${"x".repeat(200)}`,
        }),
      ],
    });

    await forgetConversation(database.db, { id, now: 5 });

    const [entry] = await listForgottenConversations(database.db);
    expect(entry?.label).toHaveLength(120);
    expect(entry?.label?.startsWith("my token is sk-SECRET-xxx")).toBe(true);
    const file = await readFile(database.path);
    expect(file.includes("sk-SECRET-")).toBe(true);
    expect(file.includes(`sk-SECRET-${"x".repeat(150)}`)).toBe(false);
  });

  it("returns null for a conversation that is not indexed", async () => {
    expect(
      await forgetConversation(database.db, { id: 404, now: 1 }),
    ).toBeNull();
    expect(await listForgottenConversations(database.db)).toEqual([]);
  });

  it("does not mark forgotten sources missing", async () => {
    const id = await index(makeSource("claude", "/c/gone.jsonl"));
    await forgetConversation(database.db, { id, now: 1 });

    await markSourcesMissing(database.db, ["/c/gone.jsonl"], 2);

    const row = await database.db
      .selectFrom("sources")
      .select("status")
      .where("path", "=", "/c/gone.jsonl")
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("forgotten");
  });

  it("restores by dropping the entry and the sources it suppressed", async () => {
    const ids = await seedFamily();
    const other = await forgetConversation(database.db, {
      id: ids.other,
      now: 1,
    });
    await forgetConversation(database.db, { id: ids.parent, now: 2 });

    expect(
      await restoreForgottenConversation(database.db, {
        agent: "claude",
        nativeId: "parent",
      }),
    ).toBe(true);
    expect(
      await restoreForgottenConversation(database.db, {
        agent: "claude",
        nativeId: "parent",
      }),
    ).toBe(false);

    expect(
      (await listForgottenConversations(database.db)).map(
        (entry) => entry.nativeId,
      ),
    ).toEqual([other?.nativeId]);
    const sources = await database.db
      .selectFrom("sources")
      .select(["path", "status"])
      .orderBy("path")
      .execute();
    expect(sources).toEqual([
      { path: "/c/fork.jsonl", status: "indexed" },
      { path: "/c/other.jsonl", status: "forgotten" },
    ]);
  });

  it("previews conversations whose transcripts are all gone", async () => {
    await index(makeSource("cursor", "/u/a/chat.jsonl"), { nativeId: "chat" });
    await index(makeSource("cursor", "/u/b/chat.jsonl"), { nativeId: "chat" });
    await index(makeSource("claude", "/c/gone.jsonl"));
    await index(makeSource("claude", "/c/here.jsonl"));
    await markSourcesMissing(
      database.db,
      ["/u/a/chat.jsonl", "/c/gone.jsonl"],
      2,
    );

    expect(await readClearIndexPreview(database.db)).toEqual({
      conversations: 3,
      conversationsWithoutTranscript: 1,
    });
  });

  it("clears everything except the forgotten list", async () => {
    const ids = await seedFamily();
    await forgetConversation(database.db, { id: ids.other, now: 1 });

    await clearIndex(database.db);
    await vacuumDatabase(database.db);

    expect(await count("conversations")).toBe(0);
    expect(await count("turns")).toBe(0);
    expect(await count("chunks")).toBe(0);
    expect(await count("turn_chunk_state")).toBe(0);
    expect(
      await database.db.selectFrom("sources").selectAll().execute(),
    ).toEqual([]);
    expect(
      (await listForgottenConversations(database.db)).map(
        (entry) => entry.nativeId,
      ),
    ).toEqual(["other"]);
    expect(await readClearIndexPreview(database.db)).toEqual({
      conversations: 0,
      conversationsWithoutTranscript: 0,
    });
  });
});
