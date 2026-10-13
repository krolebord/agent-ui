import type {
  SessionMemoryConversationMatch,
  SessionMemorySearchFilters,
  SessionMemorySearchGrouping,
  SessionMemorySearchHit,
  SessionMemorySearchInput,
} from "@shared/session-memory";
import { DISPLAY_TITLE_SOURCE_CHARS, excerpt } from "./display";
import type { SessionMemoryDb } from "./store/database";
import { listConversations, summarizeConversations } from "./store/queries";

export interface ConversationSearchDeps {
  getDatabase: () => Promise<SessionMemoryDb>;
  searchSessionMemory: (
    input: SessionMemorySearchInput,
  ) => Promise<SessionMemorySearchHit[]>;
}

export interface ConversationSearchInput extends SessionMemorySearchFilters {
  query: string;
  groupBy?: SessionMemorySearchGrouping;
  /** Conversations when grouped by conversation, turns when grouped by turn. */
  limit: number;
  snippetChars?: number;
}

export const DEFAULT_SNIPPET_CHARS = 400;

/**
 * Semantic search ranked by each conversation's best turn. Grouped by turn,
 * a conversation lists every matching turn among the top `limit` turns.
 * Conversations removed from the index mid-search are left out.
 */
export async function searchConversations(
  deps: ConversationSearchDeps,
  input: ConversationSearchInput,
): Promise<SessionMemoryConversationMatch[]> {
  const {
    query,
    groupBy,
    limit,
    snippetChars = DEFAULT_SNIPPET_CHARS,
    ...filters
  } = input;
  const byTurn = groupBy === "turn";
  const rawHits = await deps.searchSessionMemory({
    ...filters,
    query,
    limit: byTurn ? limit * 2 : limit,
    groupBy: byTurn ? "chunk" : "conversation",
  });
  const seenTurns = new Set<number>();
  const hits = rawHits
    .filter((hit) => {
      if (seenTurns.has(hit.turn.id)) return false;
      seenTurns.add(hit.turn.id);
      return true;
    })
    .slice(0, limit);
  if (hits.length === 0) {
    return [];
  }

  const db = await deps.getDatabase();
  const conversationIds = [...new Set(hits.map((hit) => hit.conversation.id))];
  const records = await listConversations(db, {
    ids: conversationIds,
    limit: conversationIds.length,
  });
  const summaries = new Map(
    (await summarizeConversations(db, records, DISPLAY_TITLE_SOURCE_CHARS)).map(
      (summary) => [summary.id, summary],
    ),
  );
  const recordsById = new Map(records.map((record) => [record.id, record]));

  return conversationIds.flatMap((conversationId) => {
    const record = recordsById.get(conversationId);
    const summary = summaries.get(conversationId);
    if (!record || !summary) return [];
    return [
      {
        conversation: {
          ...summary,
          gitBranch: record.gitBranch,
          parentNativeId: record.parentNativeId,
          parentConversationId: record.parentConversationId,
        },
        turns: hits
          .filter((hit) => hit.conversation.id === conversationId)
          .map((hit) => ({
            turnId: hit.turn.id,
            ordinal: hit.turn.ordinal,
            startedAt: hit.turn.startedAt,
            snippet: excerpt(hit.chunk.text, snippetChars),
            relevance: 1 - hit.distance,
          })),
      },
    ];
  });
}
