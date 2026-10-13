import type {
  SessionMemoryAgent,
  SessionMemoryConversationPage,
  SessionMemoryConversationSummary,
  SessionMemoryRelation,
  SessionMemorySearchFilters,
} from "@shared/session-memory";
import { type RawBuilder, type Selectable, sql } from "kysely";
import { z } from "zod";
import type { SessionMemoryDb } from "./database";
import type { ConversationsTable, TurnsTable } from "./schema";

export interface ConversationRecord {
  id: number;
  agent: SessionMemoryAgent;
  nativeId: string;
  sourcePath: string;
  cwd: string | null;
  projectPath: string | null;
  agentUiSessionId: string | null;
  gitBranch: string | null;
  gitSha: string | null;
  title: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  parentNativeId: string | null;
  parentConversationId: number | null;
  relation: SessionMemoryRelation;
  turnCount: number;
  indexedAt: number;
}

export interface TurnRecord {
  id: number;
  conversationId: number;
  ordinal: number;
  startedAt: number | null;
  userText: string;
  assistantText: string;
  filePaths: string[];
  commands: string[];
  sourceLine: number | null;
  sourceEventId: string | null;
  contentHash: string;
  contentUpdatedAt: number;
}

export interface ListConversationsFilter
  extends Omit<SessionMemorySearchFilters, "excludeConversationIds"> {
  agentUiSessionId?: string;
  /** Case-insensitive (ASCII) substring of the title or the opening user message. */
  text?: string;
  ids?: number[];
  excludeIds?: number[];
  limit?: number;
  offset?: number;
}

export type ConversationLookup =
  | { id: number }
  | { agent: SessionMemoryAgent; nativeId: string };

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

const stringArraySchema = z.array(z.string()).catch([]);

function parseStringArray(json: string): string[] {
  try {
    return stringArraySchema.parse(JSON.parse(json));
  } catch {
    return [];
  }
}

function toConversationRecord(
  row: Selectable<ConversationsTable>,
): ConversationRecord {
  return {
    id: row.id,
    agent: row.agent,
    nativeId: row.native_id,
    sourcePath: row.source_path,
    cwd: row.cwd,
    projectPath: row.project_path,
    agentUiSessionId: row.agent_ui_session_id,
    gitBranch: row.git_branch,
    gitSha: row.git_sha,
    title: row.title,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    parentNativeId: row.parent_native_id,
    parentConversationId: row.parent_conversation_id,
    relation: row.relation,
    turnCount: row.turn_count,
    indexedAt: row.indexed_at,
  };
}

function toTurnRecord(row: Selectable<TurnsTable>): TurnRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    ordinal: row.ordinal,
    startedAt: row.started_at,
    userText: row.user_text,
    assistantText: row.assistant_text,
    filePaths: parseStringArray(row.file_paths),
    commands: parseStringArray(row.commands),
    sourceLine: row.source_line,
    sourceEventId: row.source_event_id,
    contentHash: row.content_hash,
    contentUpdatedAt: row.content_updated_at,
  };
}

export function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

function openingUserTextOf(conversationId: RawBuilder<unknown>) {
  return sql<string | null>`
    SELECT t.user_text FROM turns t
    WHERE t.conversation_id = ${conversationId} AND trim(t.user_text) <> ''
    ORDER BY t.ordinal LIMIT 1
  `;
}

/** Most recently active first. */
export async function listConversations(
  db: SessionMemoryDb,
  filter: ListConversationsFilter = {},
): Promise<ConversationRecord[]> {
  let query = db.selectFrom("conversations").selectAll();

  if (filter.agent !== undefined) {
    query = query.where("agent", "in", asArray(filter.agent));
  }
  if (filter.relation !== undefined) {
    query = query.where("relation", "in", asArray(filter.relation));
  }
  if (filter.projectPath !== undefined) {
    query = query.where("project_path", "=", filter.projectPath);
  }
  if (filter.agentUiSessionId !== undefined) {
    query = query.where("agent_ui_session_id", "=", filter.agentUiSessionId);
  }
  if (filter.ids !== undefined) {
    if (filter.ids.length === 0) {
      return [];
    }
    query = query.where("id", "in", filter.ids);
  }
  if (filter.excludeIds !== undefined && filter.excludeIds.length > 0) {
    query = query.where("id", "not in", filter.excludeIds);
  }
  const text = filter.text?.trim();
  if (text) {
    const pattern = `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    query = query.where((eb) =>
      eb.or([
        sql<boolean>`conversations.title LIKE ${pattern} ESCAPE '\\'`,
        sql<boolean>`(${openingUserTextOf(sql.ref("conversations.id"))}) LIKE ${pattern} ESCAPE '\\'`,
      ]),
    );
  }
  if (filter.cwdPrefix !== undefined) {
    const prefix = filter.cwdPrefix.replace(/\/+$/, "");
    query = query.where((eb) =>
      eb.or([
        eb("cwd", "=", prefix),
        eb.and([eb("cwd", ">=", `${prefix}/`), eb("cwd", "<", `${prefix}0`)]),
      ]),
    );
  }
  if (filter.activeFrom !== undefined) {
    query = query.where(
      sql<number | null>`coalesce(updated_at, started_at)`,
      ">=",
      filter.activeFrom,
    );
  }
  if (filter.activeTo !== undefined) {
    query = query.where(
      sql<number | null>`coalesce(started_at, updated_at)`,
      "<=",
      filter.activeTo,
    );
  }

  const limit = Math.min(
    Math.max(1, Math.trunc(filter.limit ?? DEFAULT_LIST_LIMIT)),
    MAX_LIST_LIMIT,
  );
  const offset = Math.max(0, Math.trunc(filter.offset ?? 0));
  const rows = await query
    .orderBy(sql`coalesce(updated_at, started_at)`, (ob) =>
      ob.desc().nullsLast(),
    )
    .orderBy("id", "desc")
    .limit(limit)
    .offset(offset)
    .execute();
  return rows.map(toConversationRecord);
}

export async function getConversation(
  db: SessionMemoryDb,
  lookup: ConversationLookup,
): Promise<ConversationRecord | null> {
  const query = db.selectFrom("conversations").selectAll();
  const row = await ("id" in lookup
    ? query.where("id", "=", lookup.id)
    : query
        .where("agent", "=", lookup.agent)
        .where("native_id", "=", lookup.nativeId)
  ).executeTakeFirst();
  return row ? toConversationRecord(row) : null;
}

/** Ordinal bounds are inclusive. */
export async function getTurns(
  db: SessionMemoryDb,
  conversationId: number,
  range: { fromOrdinal?: number; toOrdinal?: number; limit?: number } = {},
): Promise<TurnRecord[]> {
  let query = db
    .selectFrom("turns")
    .selectAll()
    .where("conversation_id", "=", conversationId);
  if (range.fromOrdinal !== undefined) {
    query = query.where("ordinal", ">=", range.fromOrdinal);
  }
  if (range.toOrdinal !== undefined) {
    query = query.where("ordinal", "<=", range.toOrdinal);
  }
  if (range.limit !== undefined) {
    query = query.limit(Math.max(1, Math.trunc(range.limit)));
  }
  const rows = await query.orderBy("ordinal", "asc").execute();
  return rows.map(toTurnRecord);
}

/** The conversations behind native ids, plus subagents spawned from them. */
export async function findConversationIdsByNativeIds(
  db: SessionMemoryDb,
  agent: SessionMemoryAgent,
  nativeIds: string[],
): Promise<number[]> {
  if (nativeIds.length === 0) {
    return [];
  }
  const rows = await db
    .selectFrom("conversations")
    .select("id")
    .where("agent", "=", agent)
    .where((eb) =>
      eb.or([
        eb("native_id", "in", nativeIds),
        eb.and([
          eb("relation", "=", "subagent"),
          eb("parent_native_id", "in", nativeIds),
        ]),
      ]),
    )
    .execute();
  return rows.map((row) => row.id);
}

/** First non-empty user message of each conversation, cut to `maxChars`. */
export async function getOpeningUserTexts(
  db: SessionMemoryDb,
  conversationIds: number[],
  maxChars: number,
): Promise<Map<number, string>> {
  if (conversationIds.length === 0) {
    return new Map();
  }
  const result = await sql<{ conversation_id: number; text: string }>`
    SELECT t.conversation_id, substr(t.user_text, 1, ${Math.max(1, Math.trunc(maxChars))}) AS text
    FROM turns t
    WHERE t.conversation_id IN (${sql.join(conversationIds)})
      AND t.ordinal = (
        SELECT min(t2.ordinal) FROM turns t2
        WHERE t2.conversation_id = t.conversation_id AND trim(t2.user_text) <> ''
      )
  `.execute(db);
  return new Map(result.rows.map((row) => [row.conversation_id, row.text]));
}

/** Ids among `conversationIds` with at least one transcript file still on disk. */
export async function findConversationIdsWithTranscript(
  db: SessionMemoryDb,
  conversationIds: number[],
): Promise<Set<number>> {
  if (conversationIds.length === 0) {
    return new Set();
  }
  const rows = await db
    .selectFrom("sources")
    .select("conversation_id")
    .distinct()
    .where("conversation_id", "in", conversationIds)
    .where("status", "<>", "missing")
    .execute();
  return new Set(
    rows.flatMap((row) =>
      row.conversation_id === null ? [] : [row.conversation_id],
    ),
  );
}

const FIRST_USER_TEXT_MAX_CHARS = 300;

export async function summarizeConversations(
  db: SessionMemoryDb,
  records: ConversationRecord[],
  firstUserTextChars = FIRST_USER_TEXT_MAX_CHARS,
): Promise<SessionMemoryConversationSummary[]> {
  const ids = records.map((record) => record.id);
  const [openings, onDisk] = await Promise.all([
    getOpeningUserTexts(db, ids, firstUserTextChars),
    findConversationIdsWithTranscript(db, ids),
  ]);
  return records.map((record) => ({
    id: record.id,
    agent: record.agent,
    nativeId: record.nativeId,
    title: record.title,
    firstUserText: openings.get(record.id) ?? null,
    projectPath: record.projectPath,
    cwd: record.cwd,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    turnCount: record.turnCount,
    relation: record.relation,
    transcriptOnDisk: onDisk.has(record.id),
    agentUiSessionId: record.agentUiSessionId,
  }));
}

/** A page of conversations for browsing the index. */
export async function listConversationSummaries(
  db: SessionMemoryDb,
  input: {
    query?: string;
    agent?: SessionMemoryAgent;
    projectPath?: string;
    limit: number;
    offset: number;
  },
): Promise<SessionMemoryConversationPage> {
  const rows = await listConversations(db, {
    text: input.query,
    agent: input.agent,
    projectPath: input.projectPath,
    limit: input.limit + 1,
    offset: input.offset,
  });
  const conversations = await summarizeConversations(
    db,
    rows.slice(0, input.limit),
  );
  return {
    conversations,
    nextOffset:
      rows.length > input.limit ? input.offset + conversations.length : null,
  };
}
