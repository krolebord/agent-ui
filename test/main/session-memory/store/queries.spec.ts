import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ParsedConversation } from "../../../../src/main/session-memory/parsers/types";
import type { SessionMemoryDatabase } from "../../../../src/main/session-memory/store/database";
import {
  applyParseOutcome,
  markSourcesMissing,
} from "../../../../src/main/session-memory/store/index-writer";
import {
  getConversation,
  getTurns,
  listConversationSummaries,
  listConversations,
} from "../../../../src/main/session-memory/store/queries";
import {
  createTempDatabase,
  makeConversation,
  makeSource,
  makeTurn,
  outcomeOf,
} from "./fixtures";

describe("session memory queries", () => {
  let database: SessionMemoryDatabase;
  let cleanup: () => Promise<void>;

  async function insert(
    agent: ParsedConversation["agent"],
    nativeId: string,
    overrides: Partial<ParsedConversation>,
    projectPath: string | null = null,
  ) {
    const source = makeSource(agent, `/src/${agent}/${nativeId}.jsonl`);
    await applyParseOutcome(database.db, {
      source,
      outcome: outcomeOf(makeConversation(source, overrides)),
      links: { projectPath, agentUiSessionId: null },
      parserVersion: 1,
      now: 1,
    });
  }

  beforeEach(async () => {
    ({ database, cleanup } = await createTempDatabase());
    await insert(
      "claude",
      "c1",
      { cwd: "/p/app", startedAtMs: 100, updatedAtMs: 200 },
      "/p/app",
    );
    await insert(
      "codex",
      "x1",
      { cwd: "/p/app/web", startedAtMs: 300, updatedAtMs: 400 },
      "/p/app",
    );
    await insert("codex", "x2", {
      cwd: "/p/app-other",
      startedAtMs: 500,
      updatedAtMs: 600,
      relation: "fork",
      parentNativeId: "x1",
    });
    await insert("cursor", "u1", {
      cwd: null,
      startedAtMs: null,
      updatedAtMs: null,
      turns: [makeTurn(0), makeTurn(1), makeTurn(2), makeTurn(3)],
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  const ids = (records: { nativeId: string }[]) =>
    records.map((record) => record.nativeId);

  it("lists most recently active first with undated conversations last", async () => {
    expect(ids(await listConversations(database.db))).toEqual([
      "x2",
      "x1",
      "c1",
      "u1",
    ]);
  });

  it("filters by agent, relation and project", async () => {
    expect(
      ids(await listConversations(database.db, { agent: "codex" })),
    ).toEqual(["x2", "x1"]);
    expect(
      ids(
        await listConversations(database.db, { agent: ["claude", "cursor"] }),
      ),
    ).toEqual(["c1", "u1"]);
    expect(
      ids(await listConversations(database.db, { relation: "fork" })),
    ).toEqual(["x2"]);
    expect(
      ids(await listConversations(database.db, { projectPath: "/p/app" })),
    ).toEqual(["x1", "c1"]);
  });

  it("matches cwd prefixes on path boundaries", async () => {
    expect(
      ids(await listConversations(database.db, { cwdPrefix: "/p/app/" })),
    ).toEqual(["x1", "c1"]);
    expect(
      ids(await listConversations(database.db, { cwdPrefix: "/p/app/web" })),
    ).toEqual(["x1"]);
  });

  it("filters by overlapping activity range and paginates", async () => {
    expect(
      ids(
        await listConversations(database.db, {
          activeFrom: 250,
          activeTo: 450,
        }),
      ),
    ).toEqual(["x1"]);
    expect(
      ids(await listConversations(database.db, { activeFrom: 200 })),
    ).toEqual(["x2", "x1", "c1"]);
    expect(
      ids(await listConversations(database.db, { limit: 2, offset: 1 })),
    ).toEqual(["x1", "c1"]);
  });

  it("gets conversations by id or native id", async () => {
    const byNative = await getConversation(database.db, {
      agent: "codex",
      nativeId: "x1",
    });
    expect(byNative).toMatchObject({ agent: "codex", cwd: "/p/app/web" });
    await expect(
      getConversation(database.db, { id: byNative?.id ?? -1 }),
    ).resolves.toEqual(byNative);
    await expect(
      getConversation(database.db, { agent: "claude", nativeId: "x1" }),
    ).resolves.toBeNull();
  });

  it("returns turns in an inclusive ordinal range", async () => {
    const conversation = await getConversation(database.db, {
      agent: "cursor",
      nativeId: "u1",
    });
    const turns = await getTurns(database.db, conversation?.id ?? -1, {
      fromOrdinal: 1,
      toOrdinal: 2,
    });
    expect(turns.map((turn) => turn.ordinal)).toEqual([1, 2]);
    expect(turns[0]).toMatchObject({
      userText: "question 1",
      assistantText: "answer 1",
      filePaths: [],
      commands: [],
    });
  });
  it("lists summaries matching the title or opening message, case-insensitively", async () => {
    await insert("claude", "c2", {
      title: "Fix the 100% CPU_spin",
      startedAtMs: 700,
      updatedAtMs: 800,
      turns: [
        makeTurn(0, { userText: "" }),
        makeTurn(1, { userText: "Rotate the API keys please" }),
        makeTurn(2, { userText: "later message about websockets" }),
      ],
    });
    const list = (query: string) =>
      listConversationSummaries(database.db, { query, limit: 10, offset: 0 });

    expect(ids((await list("api KEYS")).conversations)).toEqual(["c2"]);
    expect(ids((await list("cpu_spin")).conversations)).toEqual(["c2"]);
    expect(ids((await list("100%")).conversations)).toEqual(["c2"]);
    expect(ids((await list("x_t")).conversations)).toEqual([]);
    expect(ids((await list("websockets")).conversations)).toEqual([]);
    expect(ids((await list("question 0")).conversations)).toEqual([
      "x2",
      "x1",
      "c1",
      "u1",
    ]);

    const [summary] = (await list("rotate")).conversations;
    expect(summary).toEqual({
      id: expect.any(Number),
      agent: "claude",
      nativeId: "c2",
      title: "Fix the 100% CPU_spin",
      firstUserText: "Rotate the API keys please",
      projectPath: null,
      cwd: "/projects/app",
      startedAt: 700,
      updatedAt: 800,
      turnCount: 3,
      relation: "main",
      transcriptOnDisk: true,
      agentUiSessionId: null,
    });
  });

  it("pages summaries by agent and flags deleted transcripts", async () => {
    await markSourcesMissing(database.db, ["/src/codex/x1.jsonl"], 5);

    const first = await listConversationSummaries(database.db, {
      agent: "codex",
      limit: 1,
      offset: 0,
    });
    expect(ids(first.conversations)).toEqual(["x2"]);
    expect(first.nextOffset).toBe(1);

    const second = await listConversationSummaries(database.db, {
      agent: "codex",
      limit: 1,
      offset: 1,
    });
    expect(ids(second.conversations)).toEqual(["x1"]);
    expect(second.conversations[0]?.transcriptOnDisk).toBe(false);
    expect(second.nextOffset).toBeNull();
  });
});
