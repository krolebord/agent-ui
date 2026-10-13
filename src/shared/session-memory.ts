export const sessionMemoryAgents = ["claude", "codex", "cursor"] as const;
export type SessionMemoryAgent = (typeof sessionMemoryAgents)[number];

export const sessionMemorySourceStatuses = [
  "indexed",
  "excluded",
  "empty",
  "failed",
  "missing",
  "forgotten",
] as const;
export type SessionMemorySourceStatus =
  (typeof sessionMemorySourceStatuses)[number];

export const sessionMemoryRelations = ["main", "subagent", "fork"] as const;
export type SessionMemoryRelation = (typeof sessionMemoryRelations)[number];

export type SessionMemorySyncStatus = "idle" | "syncing" | "error";

export interface SessionMemoryCounts {
  sources: Record<SessionMemorySourceStatus, number>;
  conversations: Record<SessionMemoryAgent, number>;
  turns: number;
}

export type SessionMemoryEmbeddingStatus =
  | "idle"
  | "downloading"
  | "embedding"
  | "paused"
  | "error"
  | "unsupported";

export type SessionMemoryModelStatus =
  | "missing"
  | "downloading"
  | "ready"
  | "error";

export interface SessionMemoryEmbeddingState {
  status: SessionMemoryEmbeddingStatus;
  model: {
    status: SessionMemoryModelStatus;
    bytesDone: number;
    bytesTotal: number;
    error: string | null;
  };
  chunksEmbedded: number;
  /** Embedded plus pending, with not-yet-chunked turns estimated. */
  chunksTotal: number;
  chunksFailed: number;
  /** Settled turns that still need chunking or embedding. */
  turnsPending: number;
  /** Turns changed too recently to embed; picked up once they settle. */
  turnsSettling: number;
  chunksPerMinute: number | null;
  tokensPerSecond: number | null;
  etaMs: number | null;
  lastEmbeddedAt: number | null;
  lastError: string | null;
}

export const defaultSessionMemoryEmbeddingState: SessionMemoryEmbeddingState = {
  status: "idle",
  model: { status: "missing", bytesDone: 0, bytesTotal: 0, error: null },
  chunksEmbedded: 0,
  chunksTotal: 0,
  chunksFailed: 0,
  turnsPending: 0,
  turnsSettling: 0,
  chunksPerMinute: null,
  tokensPerSecond: null,
  etaMs: null,
  lastEmbeddedAt: null,
  lastError: null,
};

export interface SessionMemoryState {
  enabled: boolean;
  syncStatus: SessionMemorySyncStatus;
  lastSyncStartedAt: number | null;
  lastSyncFinishedAt: number | null;
  lastSyncDurationMs: number | null;
  lastError: string | null;
  progress: { done: number; total: number } | null;
  counts: SessionMemoryCounts | null;
  embedding: SessionMemoryEmbeddingState;
}

export const defaultSessionMemoryState: SessionMemoryState = {
  enabled: false,
  syncStatus: "idle",
  lastSyncStartedAt: null,
  lastSyncFinishedAt: null,
  lastSyncDurationMs: null,
  lastError: null,
  progress: null,
  counts: null,
  embedding: defaultSessionMemoryEmbeddingState,
};

export interface SessionMemorySearchFilters {
  agent?: SessionMemoryAgent | SessionMemoryAgent[];
  projectPath?: string;
  /** Matches the directory itself and anything below it. */
  cwdPrefix?: string;
  /** Conversations whose activity overlaps `[activeFrom, activeTo]` (ms). */
  activeFrom?: number;
  activeTo?: number;
  relation?: SessionMemoryRelation | SessionMemoryRelation[];
  excludeConversationIds?: number[];
}

export interface SessionMemorySearchInput extends SessionMemorySearchFilters {
  query: string;
  limit?: number;
  /** `conversation` keeps only the best chunk of each conversation. */
  groupBy?: "chunk" | "conversation";
}

export interface SessionMemorySearchHit {
  /** Cosine distance, 0 = identical direction. */
  distance: number;
  chunk: { id: number; index: number; text: string; tokenCount: number };
  turn: { id: number; ordinal: number; startedAt: number | null };
  conversation: {
    id: number;
    agent: SessionMemoryAgent;
    nativeId: string;
    title: string | null;
    cwd: string | null;
    projectPath: string | null;
    gitBranch: string | null;
    relation: SessionMemoryRelation;
    startedAt: number | null;
    updatedAt: number | null;
    agentUiSessionId: string | null;
  };
}

export interface SessionMemoryConversationListInput {
  /** Case-insensitive substring of the title or the first user message. */
  query?: string;
  agent?: SessionMemoryAgent;
  projectPath?: string;
  limit: number;
  offset: number;
}

export interface SessionMemoryConversationSummary {
  id: number;
  agent: SessionMemoryAgent;
  nativeId: string;
  title: string | null;
  firstUserText: string | null;
  projectPath: string | null;
  cwd: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  turnCount: number;
  relation: SessionMemoryRelation;
  /** False when every transcript file behind it was deleted; the index holds the only copy. */
  transcriptOnDisk: boolean;
  agentUiSessionId: string | null;
}

export interface SessionMemoryConversationPage {
  conversations: SessionMemoryConversationSummary[];
  /** Offset of the next page, or null on the last one. */
  nextOffset: number | null;
}

export const sessionMemorySearchGroupings = ["conversation", "turn"] as const;
export type SessionMemorySearchGrouping =
  (typeof sessionMemorySearchGroupings)[number];

export interface SessionMemoryConversationSearchInput {
  query: string;
  agent?: SessionMemoryAgent;
  projectPath?: string;
  /** `conversation` (default) keeps the best turn of each conversation. */
  groupBy?: SessionMemorySearchGrouping;
}

export interface SessionMemoryMatchedConversation
  extends SessionMemoryConversationSummary {
  gitBranch: string | null;
  parentNativeId: string | null;
  parentConversationId: number | null;
}

export interface SessionMemoryTurnMatch {
  turnId: number;
  ordinal: number;
  startedAt: number | null;
  /** Whitespace-collapsed excerpt of the matching chunk. */
  snippet: string;
  /** Cosine similarity, higher is closer. */
  relevance: number;
}

export interface SessionMemoryConversationMatch {
  conversation: SessionMemoryMatchedConversation;
  /** Best match first. */
  turns: SessionMemoryTurnMatch[];
}

export interface SessionMemoryConversationSearchResult {
  /** Ranked by their best turn. */
  conversations: SessionMemoryConversationMatch[];
}

export interface SessionMemoryForgottenConversation {
  agent: SessionMemoryAgent;
  nativeId: string;
  label: string | null;
  forgottenAt: number;
}

export interface SessionMemoryClearIndexPreview {
  conversations: number;
  /** Conversations whose transcripts are gone, so a rebuild cannot bring them back. */
  conversationsWithoutTranscript: number;
}
