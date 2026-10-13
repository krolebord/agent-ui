import type {
  SessionMemoryAgent,
  SessionMemoryRelation,
  SessionMemorySearchFilters,
  SessionMemorySearchHit,
} from "@shared/session-memory";
import { type RawBuilder, sql } from "kysely";
import { vectorToBlob } from "./chunks";
import type { SessionMemoryDb } from "./database";
import { asArray } from "./queries";

export interface SearchChunksInput extends SessionMemorySearchFilters {
  vector: Float32Array;
  modelId: string;
  limit: number;
  groupBy?: "chunk" | "conversation";
}

interface HitRow {
  candidates: number;
  distance: number;
  chunk_id: number;
  chunk_index: number;
  text: string;
  token_count: number;
  turn_id: number;
  ordinal: number;
  turn_started_at: number | null;
  conversation_id: number;
  agent: SessionMemoryAgent;
  native_id: string;
  title: string | null;
  cwd: string | null;
  project_path: string | null;
  git_branch: string | null;
  relation: SessionMemoryRelation;
  started_at: number | null;
  updated_at: number | null;
  agent_ui_session_id: string | null;
}

function filterConditions(
  filters: SessionMemorySearchFilters,
): RawBuilder<unknown>[] {
  const conditions: RawBuilder<unknown>[] = [];
  if (filters.agent !== undefined) {
    const agents = asArray(filters.agent);
    conditions.push(
      agents.length === 0 ? sql`0` : sql`c.agent IN (${sql.join(agents)})`,
    );
  }
  if (filters.relation !== undefined) {
    const relations = asArray(filters.relation);
    conditions.push(
      relations.length === 0
        ? sql`0`
        : sql`c.relation IN (${sql.join(relations)})`,
    );
  }
  if (
    filters.excludeConversationIds !== undefined &&
    filters.excludeConversationIds.length > 0
  ) {
    conditions.push(
      sql`c.id NOT IN (${sql.join(filters.excludeConversationIds)})`,
    );
  }
  if (filters.projectPath !== undefined) {
    conditions.push(sql`c.project_path = ${filters.projectPath}`);
  }
  if (filters.cwdPrefix !== undefined) {
    const prefix = filters.cwdPrefix.replace(/\/+$/, "");
    conditions.push(
      sql`(c.cwd = ${prefix} OR (c.cwd >= ${`${prefix}/`} AND c.cwd < ${`${prefix}0`}))`,
    );
  }
  if (filters.activeFrom !== undefined) {
    conditions.push(
      sql`coalesce(c.updated_at, c.started_at) >= ${filters.activeFrom}`,
    );
  }
  if (filters.activeTo !== undefined) {
    conditions.push(
      sql`coalesce(c.started_at, c.updated_at) <= ${filters.activeTo}`,
    );
  }
  return conditions;
}

/**
 * Exact cosine search over every embedded chunk that passes the filters, so
 * filters never drop matches the way post-filtering an approximate KNN would.
 * Chunks with the same prompt hash (fork copies, duplicated turns) collapse to
 * the most recently active one.
 */
export async function searchChunks(
  db: SessionMemoryDb,
  input: SearchChunksInput,
): Promise<SessionMemorySearchHit[]> {
  // Ranking only the nearest candidates is exact as long as they still yield
  // `limit` distinct hits: anything outside them is farther than all of them.
  const candidateLimit =
    input.limit * (input.groupBy === "conversation" ? 10 : 3);
  const shortlist = await rankChunks(db, input, candidateLimit);
  if (
    shortlist.rows.length >= input.limit ||
    shortlist.candidates < candidateLimit
  ) {
    return shortlist.rows.map(toHit);
  }
  return (await rankChunks(db, input, null)).rows.map(toHit);
}

async function rankChunks(
  db: SessionMemoryDb,
  input: SearchChunksInput,
  candidateLimit: number | null,
): Promise<{ rows: HitRow[]; candidates: number }> {
  const conditions = [
    sql`k.vector IS NOT NULL`,
    sql`k.model_id = ${input.modelId}`,
    ...filterConditions(input),
  ];
  const groupKey =
    input.groupBy === "conversation"
      ? sql.raw("conversation_id")
      : sql.raw("chunk_id");
  const result = await sql<HitRow>`
    WITH scored AS (
      SELECT
        k.id AS chunk_id,
        k.embed_hash,
        t.conversation_id,
        coalesce(c.updated_at, c.started_at, 0) AS active_at,
        vec_distance_cosine(k.vector, ${vectorToBlob(input.vector)}) AS distance
      FROM chunks k
      JOIN turns t ON t.id = k.turn_id
      JOIN conversations c ON c.id = t.conversation_id
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY distance, active_at DESC, chunk_id DESC
      LIMIT ${candidateLimit ?? -1}
    ),
    unique_prompts AS (
      SELECT *, row_number() OVER (
        PARTITION BY embed_hash ORDER BY distance, active_at DESC, chunk_id DESC
      ) AS prompt_rank
      FROM scored
    ),
    ranked AS (
      SELECT *, row_number() OVER (
        PARTITION BY ${groupKey} ORDER BY distance, active_at DESC, chunk_id DESC
      ) AS group_rank
      FROM unique_prompts
      WHERE prompt_rank = 1
    ),
    top AS (
      SELECT chunk_id, distance, active_at FROM ranked
      WHERE group_rank = 1
      ORDER BY distance, active_at DESC, chunk_id DESC
      LIMIT ${input.limit}
    )
    SELECT
      (SELECT count(*) FROM scored) AS candidates,
      top.distance,
      k.id AS chunk_id,
      k.chunk_index,
      k.text,
      k.token_count,
      t.id AS turn_id,
      t.ordinal,
      t.started_at AS turn_started_at,
      c.id AS conversation_id,
      c.agent,
      c.native_id,
      c.title,
      c.cwd,
      c.project_path,
      c.git_branch,
      c.relation,
      c.started_at,
      c.updated_at,
      c.agent_ui_session_id
    FROM top
    JOIN chunks k ON k.id = top.chunk_id
    JOIN turns t ON t.id = k.turn_id
    JOIN conversations c ON c.id = t.conversation_id
    ORDER BY top.distance, top.active_at DESC, top.chunk_id DESC
  `.execute(db);
  return {
    rows: result.rows,
    candidates: Number(result.rows[0]?.candidates ?? 0),
  };
}

function toHit(row: HitRow): SessionMemorySearchHit {
  return {
    distance: row.distance,
    chunk: {
      id: row.chunk_id,
      index: row.chunk_index,
      text: row.text,
      tokenCount: row.token_count,
    },
    turn: {
      id: row.turn_id,
      ordinal: row.ordinal,
      startedAt: row.turn_started_at,
    },
    conversation: {
      id: row.conversation_id,
      agent: row.agent,
      nativeId: row.native_id,
      title: row.title,
      cwd: row.cwd,
      projectPath: row.project_path,
      gitBranch: row.git_branch,
      relation: row.relation,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      agentUiSessionId: row.agent_ui_session_id,
    },
  };
}
