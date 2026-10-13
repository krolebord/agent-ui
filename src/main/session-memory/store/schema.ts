import type {
  SessionMemoryAgent,
  SessionMemoryRelation,
  SessionMemorySourceStatus,
} from "@shared/session-memory";
import type { Generated } from "kysely";

export interface SourcesTable {
  path: string;
  agent: SessionMemoryAgent;
  fingerprint: string;
  parser_version: number;
  status: SessionMemorySourceStatus;
  last_error: string | null;
  conversation_id: number | null;
  /** Native id of the forgotten conversation this source belongs to, while `status` is `forgotten`. */
  forgotten_native_id: Generated<string | null>;
  created_at: number;
  updated_at: number;
}

export interface ConversationsTable {
  id: Generated<number>;
  agent: SessionMemoryAgent;
  native_id: string;
  source_path: string;
  cwd: string | null;
  project_path: string | null;
  agent_ui_session_id: string | null;
  git_branch: string | null;
  git_sha: string | null;
  title: string | null;
  /** Transcript activity times, not row bookkeeping. */
  started_at: number | null;
  updated_at: number | null;
  parent_native_id: string | null;
  parent_conversation_id: number | null;
  relation: SessionMemoryRelation;
  turn_count: number;
  created_at: number;
  indexed_at: number;
}

export interface TurnsTable {
  id: Generated<number>;
  conversation_id: number;
  ordinal: number;
  started_at: number | null;
  user_text: string;
  assistant_text: string;
  /** JSON string array. */
  file_paths: string;
  /** JSON string array. */
  commands: string;
  source_line: number | null;
  source_event_id: string | null;
  content_hash: string;
  /** Bumped only when `content_hash` changes. */
  content_updated_at: number;
  created_at: number;
  updated_at: number;
}

/** What a turn's current chunks were derived from; a mismatch means re-chunk. */
export interface TurnChunkStateTable {
  turn_id: number;
  content_hash: string;
  title: string | null;
  chunker_version: number;
  model_id: string;
  chunk_count: number;
  /** Set when chunking failed deterministically; the turn is skipped until its inputs change. */
  error: string | null;
  chunked_at: number;
}

export interface ChunksTable {
  id: Generated<number>;
  turn_id: number;
  chunk_index: number;
  text: string;
  /** sha256 of the exact document prompt that is embedded. */
  embed_hash: string;
  token_count: number;
  model_id: string;
  /** Little-endian float32, L2-normalized. */
  vector: Uint8Array | null;
  embedded_at: number | null;
  error: string | null;
}

export interface ForgottenConversationsTable {
  agent: SessionMemoryAgent;
  native_id: string;
  label: string | null;
  forgotten_at: number;
}

export interface SessionMemoryDatabaseSchema {
  sources: SourcesTable;
  conversations: ConversationsTable;
  turns: TurnsTable;
  turn_chunk_state: TurnChunkStateTable;
  chunks: ChunksTable;
  forgotten_conversations: ForgottenConversationsTable;
}
