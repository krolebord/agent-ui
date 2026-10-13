import { type RawBuilder, sql } from "kysely";
import type { PlannedChunk } from "../chunking";
import type { SessionMemoryDb } from "./database";

export interface ChunkQueueKey {
  modelId: string;
  chunkerVersion: number;
  /** Turns whose content and conversation both changed after this are still settling. */
  settledBefore: number;
}

export interface TurnToChunk {
  turnId: number;
  contentHash: string;
  title: string | null;
  userText: string;
  assistantText: string;
}

export interface ChunkToEmbed {
  id: number;
  turnId: number;
  title: string | null;
  text: string;
  embedHash: string;
  tokenCount: number;
}

export interface EmbeddingCounts {
  chunksEmbedded: number;
  chunksPending: number;
  chunksFailed: number;
  turnsPending: number;
  turnsSettling: number;
  /** Rough chunk count for settled turns that are not chunked yet. */
  estimatedUnchunked: number;
}

export function vectorToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(
    vector.buffer.slice(
      vector.byteOffset,
      vector.byteOffset + vector.byteLength,
    ),
  );
}

function needsChunking(key: ChunkQueueKey): RawBuilder<number> {
  return sql<number>`(
    s.turn_id IS NULL
    OR s.content_hash <> t.content_hash
    OR s.title IS NOT c.title
    OR s.chunker_version <> ${key.chunkerVersion}
    OR s.model_id <> ${key.modelId}
  )`;
}

const hasPendingChunks = sql<number>`EXISTS (
  SELECT 1 FROM chunks k
  WHERE k.turn_id = t.id AND k.vector IS NULL AND k.error IS NULL
)`;

function isSettled(key: ChunkQueueKey): RawBuilder<number> {
  return sql<number>`(
    t.content_updated_at <= ${key.settledBefore}
    OR coalesce(c.updated_at, t.started_at, 0) <= ${key.settledBefore}
  )`;
}

const queueFrom = sql`
  turns t
  JOIN conversations c ON c.id = t.conversation_id
  LEFT JOIN turn_chunk_state s ON s.turn_id = t.id
`;

/** Newest settled turn that needs chunking or has chunks left to embed. */
export async function findNextTurn(
  db: SessionMemoryDb,
  key: ChunkQueueKey,
): Promise<{ turnId: number; needsChunking: boolean } | null> {
  const result = await sql<{ id: number; needs_chunking: number }>`
    SELECT t.id, ${needsChunking(key)} AS needs_chunking
    FROM ${queueFrom}
    WHERE ${isSettled(key)} AND (${needsChunking(key)} OR ${hasPendingChunks})
    ORDER BY coalesce(t.started_at, c.updated_at, c.started_at, 0) DESC, t.id DESC
    LIMIT 1
  `.execute(db);
  const row = result.rows[0];
  return row
    ? { turnId: row.id, needsChunking: row.needs_chunking === 1 }
    : null;
}

/** When the earliest still-settling turn that needs work becomes eligible. */
export async function nextSettleTime(
  db: SessionMemoryDb,
  key: ChunkQueueKey,
  settleMs: number,
): Promise<number | null> {
  const result = await sql<{ earliest: number | null }>`
    SELECT min(min(t.content_updated_at, coalesce(c.updated_at, t.started_at, 0))) AS earliest
    FROM ${queueFrom}
    WHERE NOT ${isSettled(key)} AND (${needsChunking(key)} OR ${hasPendingChunks})
  `.execute(db);
  const earliest = result.rows[0]?.earliest;
  return earliest === null || earliest === undefined
    ? null
    : earliest + settleMs;
}

export async function loadTurnToChunk(
  db: SessionMemoryDb,
  turnId: number,
): Promise<TurnToChunk | null> {
  const row = await db
    .selectFrom("turns as t")
    .innerJoin("conversations as c", "c.id", "t.conversation_id")
    .select([
      "t.id",
      "t.content_hash",
      "t.user_text",
      "t.assistant_text",
      "c.title",
    ])
    .where("t.id", "=", turnId)
    .executeTakeFirst();
  return row
    ? {
        turnId: row.id,
        contentHash: row.content_hash,
        title: row.title,
        userText: row.user_text,
        assistantText: row.assistant_text,
      }
    : null;
}

interface ChunkSetInput {
  turn: Pick<TurnToChunk, "turnId" | "contentHash" | "title">;
  modelId: string;
  chunkerVersion: number;
  now: number;
}

/**
 * Replaces a turn's chunks, copying vectors from any chunk with the same
 * prompt hash and model. Returns null without writing when the turn changed
 * since it was read.
 */
export async function replaceTurnChunks(
  db: SessionMemoryDb,
  input: ChunkSetInput & { chunks: readonly PlannedChunk[] },
): Promise<{ reused: number } | null> {
  const { turn, modelId, now, chunks } = input;
  return await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom("turns as t")
      .innerJoin("conversations as c", "c.id", "t.conversation_id")
      .select(["t.content_hash", "c.title"])
      .where("t.id", "=", turn.turnId)
      .executeTakeFirst();
    if (
      !current ||
      current.content_hash !== turn.contentHash ||
      current.title !== turn.title
    ) {
      return null;
    }

    const hashes = [...new Set(chunks.map((chunk) => chunk.embedHash))];
    const reusable = new Map<string, Uint8Array>();
    if (hashes.length > 0) {
      const rows = await trx
        .selectFrom("chunks")
        .select(["embed_hash", "vector"])
        .where("model_id", "=", modelId)
        .where("vector", "is not", null)
        .where("embed_hash", "in", hashes)
        .execute();
      for (const row of rows) {
        if (row.vector) reusable.set(row.embed_hash, row.vector);
      }
    }

    await trx.deleteFrom("chunks").where("turn_id", "=", turn.turnId).execute();
    let reused = 0;
    for (const chunk of chunks) {
      const vector = reusable.get(chunk.embedHash) ?? null;
      if (vector) reused += 1;
      await trx
        .insertInto("chunks")
        .values({
          turn_id: turn.turnId,
          chunk_index: chunk.index,
          model_id: modelId,
          embed_hash: chunk.embedHash,
          token_count: chunk.tokenCount,
          embedded_at: vector ? now : null,
          error: null,
          vector,
          text: chunk.text,
        })
        .execute();
    }
    await upsertChunkState(trx, input, chunks.length, null);
    return { reused };
  });
}

/** Records a turn that cannot be chunked so the queue moves past it. */
export async function markTurnChunkingFailed(
  db: SessionMemoryDb,
  input: ChunkSetInput & { error: string },
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const turn = await trx
      .selectFrom("turns")
      .select("id")
      .where("id", "=", input.turn.turnId)
      .executeTakeFirst();
    if (!turn) return;
    await trx
      .deleteFrom("chunks")
      .where("turn_id", "=", input.turn.turnId)
      .execute();
    await upsertChunkState(trx, input, 0, input.error);
  });
}

/** False once the turn or chunk was deleted, e.g. by forgetting its conversation. */
export async function embeddingItemExists(
  db: SessionMemoryDb,
  item: { kind: "turn" | "chunk"; id: number },
): Promise<boolean> {
  const row = await db
    .selectFrom(item.kind === "turn" ? "turns" : "chunks")
    .select("id")
    .where("id", "=", item.id)
    .executeTakeFirst();
  return row !== undefined;
}

async function upsertChunkState(
  trx: SessionMemoryDb,
  input: ChunkSetInput,
  chunkCount: number,
  error: string | null,
): Promise<void> {
  const values = {
    content_hash: input.turn.contentHash,
    title: input.turn.title,
    chunker_version: input.chunkerVersion,
    model_id: input.modelId,
    chunk_count: chunkCount,
    error,
    chunked_at: input.now,
  };
  await trx
    .insertInto("turn_chunk_state")
    .values({ ...values, turn_id: input.turn.turnId })
    .onConflict((conflict) => conflict.column("turn_id").doUpdateSet(values))
    .execute();
}

export async function clearTurnChunkingFailure(
  db: SessionMemoryDb,
  turnId: number,
): Promise<void> {
  await db
    .deleteFrom("turn_chunk_state")
    .where("turn_id", "=", turnId)
    .where("error", "is not", null)
    .execute();
}

export async function nextChunkToEmbed(
  db: SessionMemoryDb,
  turnId: number,
): Promise<ChunkToEmbed | null> {
  const row = await db
    .selectFrom("chunks as k")
    .innerJoin("turn_chunk_state as s", "s.turn_id", "k.turn_id")
    .select([
      "k.id",
      "k.turn_id",
      "k.text",
      "k.embed_hash",
      "k.token_count",
      "s.title",
    ])
    .where("k.turn_id", "=", turnId)
    .where("k.vector", "is", null)
    .where("k.error", "is", null)
    .orderBy("k.chunk_index", "asc")
    .limit(1)
    .executeTakeFirst();
  return row
    ? {
        id: row.id,
        turnId: row.turn_id,
        title: row.title,
        text: row.text,
        embedHash: row.embed_hash,
        tokenCount: row.token_count,
      }
    : null;
}

/** False when the chunk was replaced or removed while it was being embedded. */
export async function storeChunkVector(
  db: SessionMemoryDb,
  chunk: Pick<ChunkToEmbed, "id" | "embedHash">,
  vector: Float32Array,
  now: number,
): Promise<boolean> {
  const result = await db
    .updateTable("chunks")
    .set({ vector: vectorToBlob(vector), embedded_at: now, error: null })
    .where("id", "=", chunk.id)
    .where("embed_hash", "=", chunk.embedHash)
    .executeTakeFirst();
  return result.numUpdatedRows > 0n;
}

/** Reuses the vector of an already embedded chunk with the same prompt. */
export async function copyVectorFromTwin(
  db: SessionMemoryDb,
  chunk: Pick<ChunkToEmbed, "id" | "embedHash">,
  modelId: string,
  now: number,
): Promise<boolean> {
  const twin = await db
    .selectFrom("chunks")
    .select("vector")
    .where("embed_hash", "=", chunk.embedHash)
    .where("model_id", "=", modelId)
    .where("vector", "is not", null)
    .limit(1)
    .executeTakeFirst();
  if (!twin?.vector) return false;
  const result = await db
    .updateTable("chunks")
    .set({ vector: twin.vector, embedded_at: now, error: null })
    .where("id", "=", chunk.id)
    .where("embed_hash", "=", chunk.embedHash)
    .executeTakeFirst();
  return result.numUpdatedRows > 0n;
}

export async function setChunkError(
  db: SessionMemoryDb,
  chunkId: number,
  error: string | null,
): Promise<void> {
  await db
    .updateTable("chunks")
    .set({ error })
    .where("id", "=", chunkId)
    .execute();
}

export async function readEmbeddingCounts(
  db: SessionMemoryDb,
  key: ChunkQueueKey,
  estimate: { charsPerChunk: number; maxChunksPerTurn: number },
): Promise<EmbeddingCounts> {
  const chunkRow = await sql<{
    embedded: number | null;
    pending: number | null;
    failed: number | null;
  }>`
    SELECT
      sum(vector IS NOT NULL AND model_id = ${key.modelId}) AS embedded,
      sum(vector IS NULL AND error IS NULL) AS pending,
      sum(vector IS NULL AND error IS NOT NULL) AS failed
    FROM chunks
  `.execute(db);
  const turnRow = await sql<{
    pending: number | null;
    settling: number | null;
    unchunked: number | null;
  }>`
    SELECT
      sum(${isSettled(key)}) AS pending,
      sum(NOT ${isSettled(key)}) AS settling,
      sum(CASE WHEN ${isSettled(key)} AND ${needsChunking(key)} THEN
        min(
          ${sql.lit(Math.trunc(estimate.maxChunksPerTurn))},
          max(1, (length(t.user_text) + length(t.assistant_text) + ${sql.lit(Math.trunc(estimate.charsPerChunk) - 1)}) / ${sql.lit(Math.trunc(estimate.charsPerChunk))})
        )
      ELSE 0 END) AS unchunked
    FROM ${queueFrom}
    WHERE ${needsChunking(key)} OR ${hasPendingChunks}
  `.execute(db);
  const chunks = chunkRow.rows[0];
  const turns = turnRow.rows[0];
  return {
    chunksEmbedded: Number(chunks?.embedded ?? 0),
    chunksPending: Number(chunks?.pending ?? 0),
    chunksFailed: Number(chunks?.failed ?? 0),
    turnsPending: Number(turns?.pending ?? 0),
    turnsSettling: Number(turns?.settling ?? 0),
    estimatedUnchunked: Number(turns?.unchunked ?? 0),
  };
}
