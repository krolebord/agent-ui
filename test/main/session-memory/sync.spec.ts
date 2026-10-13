import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ParseOutcome,
  TranscriptSource,
} from "../../../src/main/session-memory/parsers/types";
import type { SessionMemoryDatabase } from "../../../src/main/session-memory/store/database";
import {
  forgetConversation,
  restoreForgottenConversation,
} from "../../../src/main/session-memory/store/forgetting";
import type { ConversationLinker } from "../../../src/main/session-memory/store/index-writer";
import {
  getConversation,
  getTurns,
} from "../../../src/main/session-memory/store/queries";
import { runSessionMemorySync } from "../../../src/main/session-memory/sync";
import {
  createTempDatabase,
  makeConversation,
  makeSource,
  makeTurn,
  outcomeOf,
} from "./store/fixtures";

const nullLinker: ConversationLinker = {
  resolveProjectPath: async () => null,
  resolveAgentUiSessionId: () => null,
};

describe("runSessionMemorySync", () => {
  let database: SessionMemoryDatabase;
  let cleanup: () => Promise<void>;
  let files: Map<string, { source: TranscriptSource; outcome: ParseOutcome }>;
  let parse: ReturnType<
    typeof vi.fn<(source: TranscriptSource) => Promise<ParseOutcome>>
  >;
  let clock: number;

  beforeEach(async () => {
    ({ database, cleanup } = await createTempDatabase());
    files = new Map();
    clock = 10_000;
    parse = vi.fn(async (source: TranscriptSource) => {
      const file = files.get(source.path);
      if (!file) {
        throw new Error(`unexpected parse of ${source.path}`);
      }
      return file.outcome;
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  function put(source: TranscriptSource, outcome: ParseOutcome): void {
    files.set(source.path, { source, outcome });
  }

  async function sync(
    options: { parserVersion?: number; linker?: ConversationLinker } = {},
  ) {
    clock += 1_000;
    return await runSessionMemorySync({
      db: database.db,
      discover: async () => [...files.values()].map((file) => file.source),
      parse,
      linker: options.linker ?? nullLinker,
      parserVersion: options.parserVersion ?? 1,
      now: () => clock,
      yieldToEventLoop: async () => {},
    });
  }

  async function sourceRow(path: string) {
    return await database.db
      .selectFrom("sources")
      .selectAll()
      .where("path", "=", path)
      .executeTakeFirst();
  }

  it("indexes new sources and stores conversations and turns", async () => {
    const source = makeSource("claude", "/c/abc.jsonl");
    put(
      source,
      outcomeOf(
        makeConversation(source, {
          title: "Fix login",
          turns: [
            makeTurn(0, { filePaths: ["src/a.ts"], commands: ["pnpm test"] }),
            makeTurn(1),
          ],
        }),
      ),
    );

    const result = await sync();

    expect(result).toMatchObject({
      discovered: 1,
      processed: 1,
      statuses: { indexed: 1 },
    });
    const conversation = await getConversation(database.db, {
      agent: "claude",
      nativeId: "abc",
    });
    expect(conversation).toMatchObject({
      title: "Fix login",
      turnCount: 2,
      sourcePath: "/c/abc.jsonl",
      relation: "main",
    });
    const turns = await getTurns(database.db, conversation?.id ?? -1);
    expect(turns.map((turn) => turn.userText)).toEqual([
      "question 0",
      "question 1",
    ]);
    expect(turns[0]?.filePaths).toEqual(["src/a.ts"]);
    expect(turns[0]?.commands).toEqual(["pnpm test"]);
    expect(await sourceRow("/c/abc.jsonl")).toMatchObject({
      status: "indexed",
      fingerprint: "1:1",
      parser_version: 1,
      conversation_id: conversation?.id,
    });
  });

  it("skips sources whose fingerprint and parser version are unchanged", async () => {
    const source = makeSource("codex", "/x/rollout-1.jsonl");
    put(source, outcomeOf(makeConversation(source)));

    await sync();
    const second = await sync();

    expect(parse).toHaveBeenCalledTimes(1);
    expect(second.processed).toBe(0);
  });

  it("re-parses everything after a parser version bump", async () => {
    const source = makeSource("codex", "/x/rollout-1.jsonl");
    put(source, outcomeOf(makeConversation(source)));

    await sync({ parserVersion: 1 });
    const result = await sync({ parserVersion: 2 });

    expect(parse).toHaveBeenCalledTimes(2);
    expect(result.processed).toBe(1);
    expect((await sourceRow(source.path))?.parser_version).toBe(2);
  });

  it("leaves stored content alone while a transcript is truncated for a rewrite", async () => {
    const source = makeSource("cursor", "/p/chat.jsonl", "1:1");
    put(source, outcomeOf(makeConversation(source)));
    await sync();

    put(
      { ...source, size: 0, fingerprint: "0:2" },
      outcomeOf(makeConversation(source, { turns: [] })),
    );
    const result = await sync();

    expect(result.processed).toBe(0);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(await sourceRow(source.path)).toMatchObject({
      status: "indexed",
      fingerprint: "1:1",
    });
  });

  it("updates changed turns in place and keeps ids of unchanged ones", async () => {
    const source = makeSource("claude", "/c/abc.jsonl", "1:1");
    put(source, outcomeOf(makeConversation(source)));
    await sync();
    const conversationId =
      (await getConversation(database.db, { agent: "claude", nativeId: "abc" }))
        ?.id ?? -1;
    const before = await getTurns(database.db, conversationId);

    const changed = makeSource("claude", "/c/abc.jsonl", "2:2");
    put(
      changed,
      outcomeOf(
        makeConversation(changed, {
          turns: [
            makeTurn(0),
            makeTurn(1, { assistantText: "a longer answer" }),
            makeTurn(2),
          ],
        }),
      ),
    );
    await sync();
    const after = await getTurns(database.db, conversationId);

    expect(after.map((turn) => turn.id).slice(0, 2)).toEqual(
      before.map((turn) => turn.id),
    );
    expect(after[0]).toEqual(before[0]);
    expect(after[1]?.assistantText).toBe("a longer answer");
    expect(after[1]?.contentHash).not.toBe(before[1]?.contentHash);
    expect(after[1]?.contentUpdatedAt).toBeGreaterThan(
      before[1]?.contentUpdatedAt ?? Number.POSITIVE_INFINITY,
    );
    expect(after).toHaveLength(3);
    expect(
      (await getConversation(database.db, { id: conversationId }))?.turnCount,
    ).toBe(3);
  });

  it("deletes turns past the new turn count when a transcript shrinks", async () => {
    const source = makeSource("claude", "/c/abc.jsonl", "1:1");
    put(
      source,
      outcomeOf(
        makeConversation(source, {
          turns: [makeTurn(0), makeTurn(1), makeTurn(2)],
        }),
      ),
    );
    await sync();

    const rewound = makeSource("claude", "/c/abc.jsonl", "2:2");
    put(
      rewound,
      outcomeOf(makeConversation(rewound, { turns: [makeTurn(0)] })),
    );
    await sync();

    const conversation = await getConversation(database.db, {
      agent: "claude",
      nativeId: "abc",
    });
    expect(conversation?.turnCount).toBe(1);
    expect(
      (await getTurns(database.db, conversation?.id ?? -1)).map(
        (turn) => turn.ordinal,
      ),
    ).toEqual([0]);
  });

  it("records text-generation sources as excluded without content", async () => {
    const source = makeSource("cursor", "/cur/tg.jsonl");
    put(
      source,
      outcomeOf(makeConversation(source, { origin: "text-generation" })),
    );

    const result = await sync();
    await sync();

    expect(result.statuses).toEqual({ excluded: 1 });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(await sourceRow(source.path)).toMatchObject({
      status: "excluded",
      conversation_id: null,
    });
    expect(
      await database.db.selectFrom("conversations").selectAll().execute(),
    ).toEqual([]);
    expect(await database.db.selectFrom("turns").selectAll().execute()).toEqual(
      [],
    );
  });

  it("removes previously stored content once a source is classified as text generation", async () => {
    const source = makeSource("codex", "/x/rollout-tg.jsonl", "1:1");
    put(source, outcomeOf(makeConversation(source)));
    await sync();

    const reclassified = makeSource("codex", "/x/rollout-tg.jsonl", "1:1");
    put(
      reclassified,
      outcomeOf(makeConversation(reclassified, { origin: "text-generation" })),
    );
    await sync({ parserVersion: 2 });

    expect(
      await database.db.selectFrom("conversations").selectAll().execute(),
    ).toEqual([]);
    expect(await database.db.selectFrom("turns").selectAll().execute()).toEqual(
      [],
    );
  });

  it("marks vanished sources missing but keeps their conversations", async () => {
    const source = makeSource("claude", "/c/old.jsonl");
    put(source, outcomeOf(makeConversation(source)));
    await sync();

    files.delete(source.path);
    const result = await sync();

    expect(result.newlyMissing).toBe(1);
    expect((await sourceRow(source.path))?.status).toBe("missing");
    const conversation = await getConversation(database.db, {
      agent: "claude",
      nativeId: "old",
    });
    expect(conversation?.turnCount).toBe(2);
    expect(await getTurns(database.db, conversation?.id ?? -1)).toHaveLength(2);

    const again = await sync();
    expect(again.newlyMissing).toBe(0);
  });

  it("records unreadable sources as failed, keeps content, and retries them", async () => {
    const source = makeSource("claude", "/c/abc.jsonl", "1:1");
    put(source, outcomeOf(makeConversation(source)));
    await sync();

    const broken = makeSource("claude", "/c/abc.jsonl", "2:2");
    put(broken, outcomeOf(null, "EACCES"));
    await sync();
    expect(await sourceRow(source.path)).toMatchObject({
      status: "failed",
      last_error: "EACCES",
    });
    expect(
      (await getConversation(database.db, { agent: "claude", nativeId: "abc" }))
        ?.turnCount,
    ).toBe(2);

    await sync();
    expect(parse).toHaveBeenCalledTimes(3);
  });

  it("records thrown parse errors and continues with the next source", async () => {
    const bad = makeSource("claude", "/c/bad.jsonl", "1:1", 2);
    const good = makeSource("claude", "/c/good.jsonl", "1:1", 1);
    put(bad, outcomeOf(null));
    put(good, outcomeOf(makeConversation(good)));
    parse.mockImplementationOnce(async () => {
      throw new Error("boom");
    });

    const result = await sync();

    expect(result.statuses).toEqual({ failed: 1, indexed: 1 });
    expect(await sourceRow(bad.path)).toMatchObject({
      status: "failed",
      last_error: "boom",
    });
  });

  it("stores sources without turns as empty", async () => {
    const source = makeSource("cursor", "/cur/empty.jsonl");
    put(source, outcomeOf(makeConversation(source, { turns: [] })));

    const result = await sync();

    expect(result.statuses).toEqual({ empty: 1 });
    expect(
      await database.db.selectFrom("conversations").selectAll().execute(),
    ).toEqual([]);
  });

  it("drops a stored conversation when a re-parse yields no turns", async () => {
    const source = makeSource("claude", "/c/fork.jsonl");
    put(source, outcomeOf(makeConversation(source)));
    await sync();

    put(source, outcomeOf(makeConversation(source, { turns: [] })));
    const result = await sync({ parserVersion: 2 });

    expect(result.statuses).toEqual({ empty: 1 });
    expect(
      await database.db.selectFrom("conversations").selectAll().execute(),
    ).toEqual([]);
    expect(await sourceRow(source.path)).toMatchObject({
      status: "empty",
      conversation_id: null,
    });
  });

  it("links projects, agent-ui sessions and parents, and recomputes links on later syncs", async () => {
    const parentSource = makeSource("claude", "/c/parent.jsonl", "1:1", 1);
    const childSource = makeSource(
      "claude",
      "/c/parent/subagents/agent-child.jsonl",
      "1:1",
      2,
    );
    put(parentSource, outcomeOf(makeConversation(parentSource)));
    put(
      childSource,
      outcomeOf(
        makeConversation(childSource, {
          nativeId: "child",
          parentNativeId: "parent",
          relation: "subagent",
        }),
      ),
    );
    let sessionId: string | null = "ui-1";
    const linker: ConversationLinker = {
      resolveProjectPath: async (cwd) => (cwd ? "/projects" : null),
      resolveAgentUiSessionId: (conversation) =>
        conversation.nativeId === "parent" ||
        conversation.parentNativeId === "parent"
          ? sessionId
          : null,
    };

    await sync({ linker });
    const parent = await getConversation(database.db, {
      agent: "claude",
      nativeId: "parent",
    });
    const child = await getConversation(database.db, {
      agent: "claude",
      nativeId: "child",
    });
    expect(parent).toMatchObject({
      projectPath: "/projects",
      agentUiSessionId: "ui-1",
    });
    expect(child).toMatchObject({
      relation: "subagent",
      parentConversationId: parent?.id,
      agentUiSessionId: "ui-1",
    });

    sessionId = null;
    const result = await sync({ linker });
    expect(result.processed).toBe(0);
    expect(result.relinked).toBe(2);
    expect(
      (await getConversation(database.db, { id: parent?.id ?? -1 }))
        ?.agentUiSessionId,
    ).toBeNull();
  });

  it("stops between sources when aborted", async () => {
    for (const name of ["a", "b", "c"]) {
      const source = makeSource("claude", `/c/${name}.jsonl`);
      put(source, outcomeOf(makeConversation(source)));
    }
    const controller = new AbortController();
    parse.mockImplementation(async (source) => {
      controller.abort();
      return files.get(source.path)?.outcome ?? outcomeOf(null);
    });

    const result = await runSessionMemorySync({
      db: database.db,
      discover: async () => [...files.values()].map((file) => file.source),
      parse,
      linker: nullLinker,
      parserVersion: 1,
      now: () => clock,
      signal: controller.signal,
      yieldToEventLoop: async () => {},
    });

    expect(result).toMatchObject({ processed: 1, aborted: true });
  });
  describe("forgotten conversations", () => {
    async function forget(agent: TranscriptSource["agent"], nativeId: string) {
      const conversation = await getConversation(database.db, {
        agent,
        nativeId,
      });
      if (!conversation) throw new Error(`${nativeId} is not indexed`);
      await forgetConversation(database.db, {
        id: conversation.id,
        now: clock,
      });
    }

    async function conversationIds() {
      const rows = await database.db
        .selectFrom("conversations")
        .select("native_id")
        .orderBy("native_id")
        .execute();
      return rows.map((row) => row.native_id);
    }

    it("skips forgotten sources even after their fingerprint or the parser changes", async () => {
      const source = makeSource("claude", "/c/secret.jsonl", "1:1");
      put(source, outcomeOf(makeConversation(source)));
      await sync();
      await forget("claude", "secret");
      parse.mockClear();

      const changed = makeSource("claude", "/c/secret.jsonl", "2:2");
      put(changed, outcomeOf(makeConversation(changed)));
      await sync();
      await sync({ parserVersion: 2 });

      expect(parse).not.toHaveBeenCalled();
      expect(await conversationIds()).toEqual([]);
      expect(await sourceRow(source.path)).toMatchObject({
        status: "forgotten",
        fingerprint: "1:1",
      });
    });

    it("discards a forgotten conversation that shows up under another path", async () => {
      const first = makeSource("cursor", "/u/a/chat.jsonl");
      put(first, outcomeOf(makeConversation(first, { nativeId: "chat" })));
      await sync();
      await forget("cursor", "chat");

      const duplicate = makeSource("cursor", "/u/b/chat.jsonl");
      put(
        duplicate,
        outcomeOf(makeConversation(duplicate, { nativeId: "chat" })),
      );
      const result = await sync();

      expect(result.statuses).toEqual({ forgotten: 1 });
      expect(await conversationIds()).toEqual([]);
      expect(await sourceRow(duplicate.path)).toMatchObject({
        status: "forgotten",
        forgotten_native_id: "chat",
        conversation_id: null,
      });
    });

    it("skips subagents of a forgotten conversation discovered later but keeps forks", async () => {
      const parent = makeSource("claude", "/c/parent.jsonl");
      put(parent, outcomeOf(makeConversation(parent)));
      await sync();
      await forget("claude", "parent");

      const subagent = makeSource(
        "claude",
        "/c/parent/subagents/agent-late.jsonl",
      );
      put(
        subagent,
        outcomeOf(
          makeConversation(subagent, {
            relation: "subagent",
            parentNativeId: "parent",
          }),
        ),
      );
      const fork = makeSource("claude", "/c/fork.jsonl");
      put(
        fork,
        outcomeOf(
          makeConversation(fork, {
            relation: "fork",
            parentNativeId: "parent",
          }),
        ),
      );
      await sync();

      expect(await conversationIds()).toEqual(["fork"]);
      expect(await sourceRow(subagent.path)).toMatchObject({
        status: "forgotten",
        forgotten_native_id: "parent",
      });
    });

    it("keeps forgotten sources forgotten when their files disappear", async () => {
      const source = makeSource("claude", "/c/secret.jsonl");
      put(source, outcomeOf(makeConversation(source)));
      await sync();
      await forget("claude", "secret");

      files.delete(source.path);
      const result = await sync();

      expect(result.newlyMissing).toBe(0);
      expect((await sourceRow(source.path))?.status).toBe("forgotten");
    });

    it("does not store a conversation forgotten while the sync was parsing it", async () => {
      const source = makeSource("claude", "/c/secret.jsonl", "1:1");
      put(source, outcomeOf(makeConversation(source)));
      await sync();

      const changed = makeSource("claude", "/c/secret.jsonl", "2:2");
      put(changed, outcomeOf(makeConversation(changed)));
      parse.mockImplementationOnce(async (parsed) => {
        await forget("claude", "secret");
        return outcomeOf(makeConversation(parsed));
      });
      const result = await sync();

      expect(result.statuses).toEqual({ forgotten: 1 });
      expect(await conversationIds()).toEqual([]);
      expect(await sourceRow(source.path)).toMatchObject({
        status: "forgotten",
        fingerprint: "1:1",
      });
    });

    it("re-indexes a restored conversation and its subagents", async () => {
      const parent = makeSource("claude", "/c/parent.jsonl");
      const subagent = makeSource(
        "claude",
        "/c/parent/subagents/agent-a.jsonl",
      );
      put(parent, outcomeOf(makeConversation(parent)));
      put(
        subagent,
        outcomeOf(
          makeConversation(subagent, {
            relation: "subagent",
            parentNativeId: "parent",
          }),
        ),
      );
      await sync();
      await forget("claude", "parent");
      expect(await conversationIds()).toEqual([]);

      await restoreForgottenConversation(database.db, {
        agent: "claude",
        nativeId: "parent",
      });
      const result = await sync();

      expect(result.statuses).toEqual({ indexed: 2 });
      expect(await conversationIds()).toEqual(["agent-a", "parent"]);
      const restored = await getConversation(database.db, {
        agent: "claude",
        nativeId: "agent-a",
      });
      expect(restored?.parentConversationId).not.toBeNull();
    });
  });
});
