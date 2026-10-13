import type { ClaudeProject } from "@shared/claude-types";
import type {
  SessionMemoryClearIndexPreview,
  SessionMemoryConversationSummary,
  SessionMemoryEmbeddingState,
  SessionMemoryEmbeddingStatus,
  SessionMemoryTurnMatch,
} from "@shared/session-memory";

const numberFormat = new Intl.NumberFormat("en-US");

export function formatCount(value: number): string {
  return numberFormat.format(value);
}

export function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

export function progressPercent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (done / total) * 100));
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export const embeddingStatusLabels: Record<
  SessionMemoryEmbeddingStatus,
  string
> = {
  idle: "Up to date",
  downloading: "Downloading model",
  embedding: "Indexing",
  paused: "Paused",
  error: "Stopped on error",
  unsupported: "Unsupported",
};

export interface EmbeddingProgressView {
  percent: number;
  countLabel: string;
  rateLabel: string | null;
  etaLabel: string | null;
}

export function describeEmbeddingProgress(
  embedding: SessionMemoryEmbeddingState,
): EmbeddingProgressView {
  const { chunksEmbedded, chunksTotal, chunksPerMinute, tokensPerSecond } =
    embedding;
  const rateParts: string[] = [];
  if (chunksPerMinute !== null) {
    rateParts.push(
      `${chunksPerMinute.toFixed(chunksPerMinute < 10 ? 1 : 0)} chunks/min`,
    );
  }
  if (tokensPerSecond !== null) {
    rateParts.push(`${Math.round(tokensPerSecond)} tokens/s`);
  }
  return {
    percent: progressPercent(chunksEmbedded, chunksTotal),
    countLabel: `${formatCount(chunksEmbedded)} of ~${formatCount(chunksTotal)} chunks`,
    rateLabel: rateParts.length > 0 ? rateParts.join(" · ") : null,
    etaLabel:
      embedding.etaMs !== null && embedding.etaMs > 0
        ? `about ${formatDuration(embedding.etaMs)} left`
        : null,
  };
}

function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function collapseWhitespace(text: string | null): string | null {
  const collapsed = text?.replace(/\s+/g, " ").trim();
  return collapsed ? collapsed : null;
}

export function conversationLabel(
  conversation: Pick<
    SessionMemoryConversationSummary,
    "title" | "firstUserText"
  >,
): string {
  return (
    collapseWhitespace(conversation.title) ??
    collapseWhitespace(conversation.firstUserText) ??
    "Untitled conversation"
  );
}

/** Last path segment of the project, falling back to the working directory. */
export function conversationProjectName(
  conversation: Pick<SessionMemoryConversationSummary, "projectPath" | "cwd">,
): string | null {
  const directory = conversation.projectPath ?? conversation.cwd;
  if (!directory) return null;
  const trimmed = directory.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || trimmed || null;
}

const sameYearDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});
const otherYearDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function formatActivityDate(
  at: number | null,
  now: number = Date.now(),
): string | null {
  if (at === null) return null;
  const date = new Date(at);
  return (
    date.getFullYear() === new Date(now).getFullYear()
      ? sameYearDate
      : otherYearDate
  ).format(date);
}

export function describeForgetWarning(
  conversation: Pick<SessionMemoryConversationSummary, "relation">,
): string {
  return conversation.relation === "subagent"
    ? "Deletes this subagent conversation and its embeddings from the index. It will not be indexed again, even if its transcript is still on disk."
    : "Deletes this conversation, its subagent conversations and their embeddings from the index. Forks are kept. It will not be indexed again, even if its transcript is still on disk.";
}

export function describeClearIndexWarning(
  preview: SessionMemoryClearIndexPreview,
  enabled: boolean,
): string {
  const rebuild = enabled
    ? "All indexed conversations and embeddings are deleted and rebuilt from the transcripts still on disk; embedding starts over."
    : "All indexed conversations and embeddings are deleted. They are rebuilt from the transcripts still on disk when session memory is turned back on.";
  const lost =
    preview.conversationsWithoutTranscript > 0
      ? `${plural(preview.conversationsWithoutTranscript, "conversation")} whose ${preview.conversationsWithoutTranscript === 1 ? "transcript was" : "transcripts were"} deleted will be lost permanently.`
      : "Every indexed conversation still has its transcript on disk, so nothing is lost permanently.";
  return `${rebuild} ${lost} Forgotten conversations stay forgotten.`;
}

export type ConversationSearchMode = "semantic" | "text";

/** Why semantic search cannot run right now, or null when it can. */
export function semanticSearchUnavailableReason(
  embedding: Pick<
    SessionMemoryEmbeddingState,
    "status" | "model" | "chunksEmbedded"
  >,
): string | null {
  if (embedding.status === "unsupported") {
    return "Semantic search is not available in this build.";
  }
  if (embedding.model.status === "downloading") {
    return "Semantic search becomes available once the embedding model finishes downloading.";
  }
  if (embedding.model.status === "error") {
    return "Semantic search is unavailable because the embedding model could not be downloaded.";
  }
  if (embedding.chunksEmbedded === 0) {
    return "Semantic search becomes available once the first conversations are embedded.";
  }
  return null;
}

export function resolveSearchMode(
  chosen: ConversationSearchMode | null,
  semanticAvailable: boolean,
): ConversationSearchMode {
  return semanticAvailable ? (chosen ?? "semantic") : "text";
}

export function describeSemanticSearchFailure(message: string): string {
  const reason = message.trim().replace(/\.+$/, "") || "Semantic search failed";
  return `${reason}. Showing text matches instead.`;
}

export function describeSearchCoverage(
  embedding: Pick<
    SessionMemoryEmbeddingState,
    "chunksEmbedded" | "chunksTotal"
  >,
): string | null {
  if (embedding.chunksEmbedded >= embedding.chunksTotal) return null;
  return `Embedded ${formatCount(embedding.chunksEmbedded)} / ${formatCount(embedding.chunksTotal)} chunks; older conversations may be missing.`;
}

const timeOfDay = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function describeTurnMatch(
  turn: Pick<SessionMemoryTurnMatch, "ordinal" | "startedAt" | "relevance">,
  turnCount: number,
  now: number = Date.now(),
): string {
  const parts = [
    `Turn ${formatCount(turn.ordinal + 1)} of ${formatCount(turnCount)}`,
  ];
  const date = formatActivityDate(turn.startedAt, now);
  if (date !== null && turn.startedAt !== null) {
    parts.push(`${date}, ${timeOfDay.format(turn.startedAt)}`);
  }
  parts.push(`relevance ${turn.relevance.toFixed(2)}`);
  return parts.join(" · ");
}

export interface ProjectFilterOption {
  path: string;
  label: string;
}

/** Registered projects; worktrees are covered by their origin project. */
export function projectFilterOptions(
  projects: readonly Pick<
    ClaudeProject,
    "path" | "alias" | "worktreeOriginPath"
  >[],
): ProjectFilterOption[] {
  return projects
    .filter((project) => !project.worktreeOriginPath)
    .map((project) => ({
      path: project.path,
      label:
        project.alias?.trim() ||
        conversationProjectName({ projectPath: project.path, cwd: null }) ||
        project.path,
    }))
    .sort(
      (a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path),
    );
}
