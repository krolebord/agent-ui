import type {
  SessionMemoryAgent,
  SessionMemorySearchInput,
} from "@shared/session-memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ParsedConversation } from "../../../src/main/session-memory/parsers/types";
import {
  type ConversationSearchDeps,
  searchConversations,
} from "../../../src/main/session-memory/search-conversations";
import {
  replaceTurnChunks,
  storeChunkVector,
} from "../../../src/main/session-memory/store/chunks";
import type { SessionMemoryDatabase } from "../../../src/main/session-memory/store/database";
import { applyParseOutcome } from "../../../src/main/session-memory/store/index-writer";
import { searchChunks } from "../../../src/main/session-memory/store/search";
import {
  createTempDatabase,
  makeConversation,
  makeSource,
  makeTurn,
  outcomeOf,
} from "./store/fixtures";

const MODEL = "model-a";

function unit(angleDegrees: number): Float32Array {
  const vector = new Float32Array(768);
  const radians = (angleDegrees * Math.PI) / 180;
  vector[0] = Math.cos(radians);
  vector[1] = Math.sin(radians);
  return vector;
}

describe("searchConversations", () => {
  let database: SessionMemoryDatabase;
  let cleanup: () => Promise<void>;
  let searchCalls: SessionMemorySearchInput[];
  let afterSearch: () => Promise<void>;
  let deps: ConversationSearchDeps;

  beforeEach(async () => {
    ({ database, cleanup } = await createTempDatabase());
    searchCalls = [];
    afterSearch = async () => {};
    deps = {
      getDatabase: async () => database.db,
      // The query is an angle so tests control the distances.
      searchSessionMemory: async (input) => {
        searchCalls.push(input);
        const { query, limit, groupBy, ...filters } = input;
        const hits = await searchChunks(database.db, {
          ...filters,
          vector: unit(Number(query)),
          modelId: MODEL,
          limit: limit ?? 10,
          groupBy,
        });
        await afterSearch();
        return hits;
      },
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  /** Each turn is a list of chunk angles; chunk text is "<id> turn <n> chunk <i>". */
  async function addConversation(
    nativeId: string,
    options: {
      agent?: SessionMemoryAgent;
      projectPath?: string | null;
      overrides?: Partial<ParsedConversation>;
      turns: number[][];
    },
  ): Promise<number> {
    const source = makeSource(
      options.agent ?? "claude",
      `/src/${nativeId}.jsonl`,
    );
    await applyParseOutcome(database.db, {
      source,
      outcome: outcomeOf(
        makeConversation(source, {
          nativeId,
          turns: options.turns.map((_, ordinal) =>
            makeTurn(ordinal, {
              startedAtMs: 10_000 + ordinal,
              userText: `${nativeId} question ${ordinal}`,
            }),
          ),
          ...options.overrides,
        }),
      ),
      links: {
        projectPath: options.projectPath ?? null,
        agentUiSessionId: null,
      },
      parserVersion: 1,
      now: 1,
    });
    const turns = await database.db
      .selectFrom("turns")
      .innerJoin("conversations", "conversations.id", "turns.conversation_id")
      .select([
        "turns.id",
        "turns.ordinal",
        "turns.content_hash",
        "turns.conversation_id",
        "conversations.title",
      ])
      .where("conversations.native_id", "=", nativeId)
      .orderBy("turns.ordinal")
      .execute();
    for (const turn of turns) {
      const angles = options.turns[turn.ordinal] ?? [];
      await replaceTurnChunks(database.db, {
        turn: {
          turnId: turn.id,
          contentHash: turn.content_hash,
          title: turn.title,
        },
        modelId: MODEL,
        chunkerVersion: 1,
        now: 1,
        chunks: angles.map((_, index) => ({
          index,
          text: `${nativeId} turn ${turn.ordinal}\n\n  chunk ${index}`,
          tokenCount: 10,
          embedHash: `${nativeId}-${turn.ordinal}-${index}`,
        })),
      });
      const chunks = await database.db
        .selectFrom("chunks")
        .select(["id", "embed_hash", "chunk_index"])
        .where("turn_id", "=", turn.id)
        .execute();
      for (const chunk of chunks) {
        await storeChunkVector(
          database.db,
          { id: chunk.id, embedHash: chunk.embed_hash },
          unit(angles[chunk.chunk_index] ?? 0),
          1,
        );
      }
    }
    return turns[0]?.conversation_id ?? -1;
  }

  it("ranks conversations by their best turn with display details", async () => {
    await addConversation("far", { turns: [[60]] });
    const nearId = await addConversation("near", {
      agent: "codex",
      projectPath: "/projects/app",
      overrides: {
        title: "Fix the flaky test",
        gitBranch: "feat/x",
        relation: "fork",
        parentNativeId: "origin",
      },
      turns: [[40], [10]],
    });
    await database.db
      .updateTable("sources")
      .set({ status: "missing" })
      .where("path", "=", "/src/near.jsonl")
      .execute();

    const matches = await searchConversations(deps, {
      query: "0",
      limit: 10,
    });

    expect(searchCalls[0]).toMatchObject({
      groupBy: "conversation",
      limit: 10,
    });
    expect(matches.map((match) => match.conversation.nativeId)).toEqual([
      "near",
      "far",
    ]);
    const [near, far] = matches;
    expect(near?.conversation).toMatchObject({
      id: nearId,
      agent: "codex",
      title: "Fix the flaky test",
      firstUserText: "near question 0",
      projectPath: "/projects/app",
      cwd: "/projects/app",
      gitBranch: "feat/x",
      relation: "fork",
      parentNativeId: "origin",
      parentConversationId: null,
      turnCount: 2,
      transcriptOnDisk: false,
      agentUiSessionId: null,
    });
    expect(near?.turns).toHaveLength(1);
    expect(near?.turns[0]).toMatchObject({
      ordinal: 1,
      startedAt: 10_001,
      snippet: "near turn 1 chunk 0",
    });
    expect(near?.turns[0]?.relevance).toBeCloseTo(Math.cos(Math.PI / 18), 5);
    expect(far?.conversation).toMatchObject({
      title: null,
      firstUserText: "far question 0",
      transcriptOnDisk: true,
    });
  });

  it("lists matching turns per conversation when grouped by turn", async () => {
    await addConversation("split", { turns: [[5, 8], [20], [70]] });
    await addConversation("other", { turns: [[12]] });

    const matches = await searchConversations(deps, {
      query: "0",
      groupBy: "turn",
      limit: 3,
      snippetChars: 12,
    });

    expect(searchCalls[0]).toMatchObject({ groupBy: "chunk", limit: 6 });
    expect(
      matches.map((match) => [
        match.conversation.nativeId,
        match.turns.map((turn) => turn.ordinal),
      ]),
    ).toEqual([
      ["split", [0, 1]],
      ["other", [0]],
    ]);
    expect(matches[0]?.turns[0]?.snippet).toBe("split turn…");
    expect(matches[0]?.turns[0]?.relevance).toBeGreaterThan(
      matches[0]?.turns[1]?.relevance ?? 1,
    );
  });

  it("passes filters through and returns nothing without hits", async () => {
    await addConversation("app", {
      agent: "codex",
      projectPath: "/projects/app",
      turns: [[0]],
    });

    const matches = await searchConversations(deps, {
      query: "0",
      agent: "claude",
      projectPath: "/projects/app",
      cwdPrefix: "/projects",
      activeFrom: 1,
      activeTo: 5_000,
      excludeConversationIds: [99],
      limit: 5,
    });

    expect(matches).toEqual([]);
    expect(searchCalls[0]).toEqual({
      query: "0",
      agent: "claude",
      projectPath: "/projects/app",
      cwdPrefix: "/projects",
      activeFrom: 1,
      activeTo: 5_000,
      excludeConversationIds: [99],
      limit: 5,
      groupBy: "conversation",
    });
  });

  it("leaves out conversations removed while searching", async () => {
    const goneId = await addConversation("gone", { turns: [[0]] });
    await addConversation("kept", { turns: [[30]] });
    afterSearch = async () => {
      await database.db
        .deleteFrom("conversations")
        .where("id", "=", goneId)
        .execute();
    };

    const matches = await searchConversations(deps, {
      query: "0",
      limit: 10,
    });

    expect(matches.map((match) => match.conversation.nativeId)).toEqual([
      "kept",
    ]);
  });
});
