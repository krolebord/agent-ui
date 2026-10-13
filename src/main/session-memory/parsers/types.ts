import type { ClaudeForkFinder } from "./claude-forks";

export type TranscriptAgent = "claude" | "codex" | "cursor";

export type ConversationRelation = "main" | "subagent" | "fork";

export type ConversationOrigin = "user" | "text-generation";

export interface ParsedTurn {
  ordinal: number;
  startedAtMs: number | null;
  userText: string;
  assistantText: string;
  filePaths: string[];
  commands: string[];
  sourceRef: { line: number | null; eventId: string | null };
}

export interface ParsedConversation {
  agent: TranscriptAgent;
  nativeId: string;
  sourcePath: string;
  cwd: string | null;
  gitBranch: string | null;
  gitSha: string | null;
  title: string | null;
  startedAtMs: number | null;
  updatedAtMs: number | null;
  parentNativeId: string | null;
  relation: ConversationRelation;
  origin: ConversationOrigin;
  turns: ParsedTurn[];
}

/**
 * One conversation on disk. Re-parse when `fingerprint` changes; it covers the
 * transcript and any side file the parser reads.
 */
export interface TranscriptSource {
  agent: TranscriptAgent;
  path: string;
  size: number;
  mtimeMs: number;
  /** Claude subagent `.meta.json` or Cursor chat `meta.json`. */
  metaPath: string | null;
  metaMtimeMs: number | null;
  fingerprint: string;
}

export interface TextGenerationRules {
  /** Exact cwds used for agent-ui text generation. */
  workspaceDirs: string[];
  /** Any cwd under one of these is text generation. */
  excludedCwdPrefixes: string[];
}

export interface ParseContext {
  textGeneration: TextGenerationRules;
  claudeForks?: ClaudeForkFinder;
}

export interface ParseDiagnostics {
  lines: number;
  malformedLines: number;
  unknownLineTypes: Record<string, number>;
  readError: string | null;
}

export interface ParseOutcome {
  /** Null when the file is unreadable or holds no conversation identity. */
  conversation: ParsedConversation | null;
  diagnostics: ParseDiagnostics;
}
