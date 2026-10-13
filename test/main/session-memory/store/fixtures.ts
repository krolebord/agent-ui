import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ParsedConversation,
  ParsedTurn,
  ParseOutcome,
  TranscriptAgent,
  TranscriptSource,
} from "../../../../src/main/session-memory/parsers/types";
import { SessionMemoryDatabase } from "../../../../src/main/session-memory/store/database";

export async function createTempDatabase(): Promise<{
  database: SessionMemoryDatabase;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-ui-session-memory-"));
  const database = await SessionMemoryDatabase.create(dir);
  return {
    database,
    cleanup: async () => {
      await database.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function makeSource(
  agent: TranscriptAgent,
  sourcePath: string,
  fingerprint = "1:1",
  mtimeMs = 1,
): TranscriptSource {
  return {
    agent,
    path: sourcePath,
    size: 1,
    mtimeMs,
    metaPath: null,
    metaMtimeMs: null,
    fingerprint,
  };
}

export function makeTurn(
  ordinal: number,
  overrides: Partial<ParsedTurn> = {},
): ParsedTurn {
  return {
    ordinal,
    startedAtMs: 1_000 + ordinal,
    userText: `question ${ordinal}`,
    assistantText: `answer ${ordinal}`,
    filePaths: [],
    commands: [],
    sourceRef: { line: ordinal + 1, eventId: null },
    ...overrides,
  };
}

export function makeConversation(
  source: TranscriptSource,
  overrides: Partial<ParsedConversation> = {},
): ParsedConversation {
  return {
    agent: source.agent,
    nativeId: path.basename(source.path, ".jsonl"),
    sourcePath: source.path,
    cwd: "/projects/app",
    gitBranch: "main",
    gitSha: null,
    title: null,
    startedAtMs: 1_000,
    updatedAtMs: 2_000,
    parentNativeId: null,
    relation: "main",
    origin: "user",
    turns: [makeTurn(0), makeTurn(1)],
    ...overrides,
  };
}

export function outcomeOf(
  conversation: ParsedConversation | null,
  readError: string | null = null,
): ParseOutcome {
  return {
    conversation,
    diagnostics: {
      lines: 0,
      malformedLines: 0,
      unknownLineTypes: {},
      readError,
    },
  };
}
