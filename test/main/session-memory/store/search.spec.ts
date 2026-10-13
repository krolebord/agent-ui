import type { SessionMemoryAgent } from "@shared/session-memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ParsedConversation } from "../../../../src/main/session-memory/parsers/types";
import {
  replaceTurnChunks,
  storeChunkVector,
} from "../../../../src/main/session-memory/store/chunks";
import type { SessionMemoryDatabase } from "../../../../src/main/session-memory/store/database";
import { applyParseOutcome } from "../../../../src/main/session-memory/store/index-writer";
import { searchChunks } from "../../../../src/main/session-memory/store/search";
import {
  createTempDatabase,
  makeConversation,
  makeSource,
  makeTurn,
  outcomeOf,
} from "./fixtures";

const MODEL = "model-a";

function unit(angleDegrees: number): Float32Array {
  const vector = new Float32Array(768);
  const radians = (angleDegrees * Math.PI) / 180;
  vector[0] = Math.cos(radians);
  vector[1] = Math.sin(radians);
  return vector;
}

describe("searchChunks", () => {
  let database: SessionMemoryDatabase;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ database, cleanup } = await createTempDatabase());
  });

  afterEach(async () => {
    await cleanup();
  });

  async function addConversation(
    nativeId: string,
    options: {
      agent?: SessionMemoryAgent;
      projectPath?: string | null;
      overrides?: Partial<ParsedConversation>;
      /** One chunk per entry: [angle, embedHash]. */
      chunks: Array<[number, string?]>;
      modelId?: string;
    },
  ) {
    const source = makeSource(
      options.agent ?? "claude",
      `/src/${nativeId}.jsonl`,
    );
    await applyParseOutcome(database.db, {
      source,
      outcome: outcomeOf(
        makeConversation(source, {
          nativeId,
          title: `title ${nativeId}`,
          turns: [makeTurn(0)],
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
    const turn = await database.db
      .selectFrom("turns")
      .innerJoin("conversations", "conversations.id", "turns.conversation_id")
      .select(["turns.id", "turns.content_hash", "conversations.title"])
      .where("conversations.native_id", "=", nativeId)
      .executeTakeFirstOrThrow();
    await replaceTurnChunks(database.db, {
      turn: {
        turnId: turn.id,
        contentHash: turn.content_hash,
        title: turn.title,
      },
      modelId: options.modelId ?? MODEL,
      chunkerVersion: 1,
      now: 1,
      chunks: options.chunks.map(([angle, hash], index) => ({
        index,
        text: `${nativeId} chunk ${index} at ${angle}`,
        tokenCount: 10,
        embedHash: hash ?? `${nativeId}-${index}`,
      })),
    });
    const rows = await database.db
      .selectFrom("chunks")
      .select(["id", "embed_hash", "chunk_index"])
      .where("turn_id", "=", turn.id)
      .orderBy("chunk_index")
      .execute();
    for (const row of rows) {
      await storeChunkVector(
        database.db,
        { id: row.id, embedHash: row.embed_hash },
        unit(options.chunks[row.chunk_index][0]),
        1,
      );
    }
  }

  async function search(
    input: Partial<Parameters<typeof searchChunks>[1]> = {},
  ) {
    const hits = await searchChunks(database.db, {
      vector: unit(0),
      modelId: MODEL,
      limit: 10,
      ...input,
    });
    return hits.map((hit) => hit.chunk.text);
  }

  it("ranks by cosine distance and returns turn and conversation details", async () => {
    await addConversation("far", { chunks: [[80]] });
    await addConversation("near", {
      agent: "codex",
      projectPath: "/projects/app",
      chunks: [[10], [30]],
      overrides: { gitBranch: "feat/x", relation: "fork" },
    });

    const hits = await searchChunks(database.db, {
      vector: unit(0),
      modelId: MODEL,
      limit: 2,
    });

    expect(hits.map((hit) => hit.chunk.text)).toEqual([
      "near chunk 0 at 10",
      "near chunk 1 at 30",
    ]);
    expect(hits[0].distance).toBeCloseTo(1 - Math.cos(Math.PI / 18), 5);
    expect(hits[0]).toMatchObject({
      chunk: { index: 0, tokenCount: 10 },
      turn: { ordinal: 0, startedAt: 1_000 },
      conversation: {
        agent: "codex",
        nativeId: "near",
        title: "title near",
        cwd: "/projects/app",
        projectPath: "/projects/app",
        gitBranch: "feat/x",
        relation: "fork",
        startedAt: 1_000,
        updatedAt: 2_000,
        agentUiSessionId: null,
      },
    });
  });

  it("applies filters before ranking", async () => {
    await addConversation("claude-app", {
      projectPath: "/projects/app",
      chunks: [[5]],
      overrides: {
        cwd: "/projects/app/packages/web",
        startedAtMs: 10_000,
        updatedAtMs: 20_000,
      },
    });
    await addConversation("codex-other", {
      agent: "codex",
      projectPath: "/projects/other",
      chunks: [[1]],
      overrides: {
        cwd: "/projects/other",
        startedAtMs: 30_000,
        updatedAtMs: 40_000,
        relation: "subagent",
      },
    });
    await addConversation("cursor-app2", {
      agent: "cursor",
      chunks: [[60]],
      overrides: {
        cwd: "/projects/app2",
        startedAtMs: 50_000,
        updatedAtMs: 60_000,
      },
    });

    expect(await search({ agent: "codex" })).toEqual([
      "codex-other chunk 0 at 1",
    ]);
    expect(await search({ agent: ["claude", "cursor"] })).toEqual([
      "claude-app chunk 0 at 5",
      "cursor-app2 chunk 0 at 60",
    ]);
    expect(await search({ projectPath: "/projects/app" })).toEqual([
      "claude-app chunk 0 at 5",
    ]);
    expect(await search({ cwdPrefix: "/projects/app/" })).toEqual([
      "claude-app chunk 0 at 5",
    ]);
    expect(await search({ activeFrom: 35_000, activeTo: 55_000 })).toEqual([
      "codex-other chunk 0 at 1",
      "cursor-app2 chunk 0 at 60",
    ]);
    expect(await search({ relation: "main" })).toEqual([
      "claude-app chunk 0 at 5",
      "cursor-app2 chunk 0 at 60",
    ]);
    expect(await search({ agent: [] })).toEqual([]);
  });

  it("collapses identical prompts and can group by conversation", async () => {
    await addConversation("original", {
      chunks: [[10, "shared"], [20]],
      overrides: { updatedAtMs: 1_000 },
    });
    await addConversation("fork", {
      chunks: [[10, "shared"], [40]],
      overrides: { updatedAtMs: 9_000 },
    });

    expect(await search()).toEqual([
      "fork chunk 0 at 10",
      "original chunk 1 at 20",
      "fork chunk 1 at 40",
    ]);
    expect(await search({ groupBy: "conversation" })).toEqual([
      "fork chunk 0 at 10",
      "original chunk 1 at 20",
    ]);
  });

  it("stays exact when the nearest candidates collapse into few hits", async () => {
    await addConversation("dense", {
      chunks: Array.from({ length: 25 }, (_, index): [number] => [index + 1]),
    });
    for (let copy = 0; copy < 7; copy++) {
      await addConversation(`copy${copy}`, {
        chunks: [[0.5, "duplicated"]],
        overrides: { updatedAtMs: 2_000 + copy },
      });
    }
    await addConversation("sparse", { chunks: [[60]] });

    expect(await search({ groupBy: "conversation", limit: 3 })).toEqual([
      "copy6 chunk 0 at 0.5",
      "dense chunk 0 at 1",
      "sparse chunk 0 at 60",
    ]);
    expect(await search({ limit: 2, agent: "claude" })).toEqual([
      "copy6 chunk 0 at 0.5",
      "dense chunk 0 at 1",
    ]);
  });

  it("ignores chunks without vectors or from another model", async () => {
    await addConversation("current", { chunks: [[50]] });
    await addConversation("stale", { chunks: [[0]], modelId: "model-old" });
    await database.db
      .updateTable("chunks")
      .set({ vector: null })
      .where("text", "like", "current%")
      .execute();
    await addConversation("fresh", { chunks: [[70]] });

    expect(await search()).toEqual(["fresh chunk 0 at 70"]);
  });
});
