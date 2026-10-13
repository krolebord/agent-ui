import { createHash } from "node:crypto";
import {
  type SessionMemoryAgent,
  type SessionMemoryCounts,
  type SessionMemorySourceStatus,
  sessionMemoryAgents,
  sessionMemorySourceStatuses,
} from "@shared/session-memory";
import type { Transaction } from "kysely";
import type {
  ParsedConversation,
  ParsedTurn,
  ParseOutcome,
  TranscriptSource,
} from "../parsers";
import type { SessionMemoryDb } from "./database";
import type { SessionMemoryDatabaseSchema } from "./schema";

type Trx = Transaction<SessionMemoryDatabaseSchema>;

const IN_CHUNK_SIZE = 500;

export interface SourceRecord {
  path: string;
  fingerprint: string;
  parserVersion: number;
  status: SessionMemorySourceStatus;
}

export interface ConversationLinks {
  projectPath: string | null;
  agentUiSessionId: string | null;
}

export async function loadSourceRecords(
  db: SessionMemoryDb,
): Promise<Map<string, SourceRecord>> {
  const rows = await db
    .selectFrom("sources")
    .select(["path", "fingerprint", "parser_version", "status"])
    .execute();
  return new Map(
    rows.map((row) => [
      row.path,
      {
        path: row.path,
        fingerprint: row.fingerprint,
        parserVersion: row.parser_version,
        status: row.status,
      },
    ]),
  );
}

export function turnContentHash(
  turn: Pick<ParsedTurn, "userText" | "assistantText">,
): string {
  return createHash("sha256")
    .update(turn.userText)
    .update("\u0000")
    .update(turn.assistantText)
    .digest("hex");
}

interface SourceUpdate {
  status: SessionMemorySourceStatus;
  lastError: string | null;
  /** `undefined` keeps the stored link. */
  conversationId?: number | null;
  forgottenNativeId?: string;
}

async function upsertSource(
  trx: Trx,
  source: TranscriptSource,
  parserVersion: number,
  now: number,
  update: SourceUpdate,
): Promise<void> {
  const shared = {
    agent: source.agent,
    fingerprint: source.fingerprint,
    parser_version: parserVersion,
    status: update.status,
    last_error: update.lastError,
    forgotten_native_id: update.forgottenNativeId ?? null,
    updated_at: now,
  };
  await trx
    .insertInto("sources")
    .values({
      ...shared,
      path: source.path,
      conversation_id: update.conversationId ?? null,
      created_at: now,
    })
    .onConflict((conflict) =>
      conflict
        .column("path")
        .doUpdateSet(
          update.conversationId === undefined
            ? shared
            : { ...shared, conversation_id: update.conversationId },
        )
        .where("sources.status", "<>", "forgotten"),
    )
    .execute();
}

/** The forgotten native id that suppresses this conversation: its own, or its parent's for a subagent. */
async function findForgottenNativeId(
  trx: Trx,
  conversation: ParsedConversation,
): Promise<string | null> {
  const candidates = [conversation.nativeId];
  if (
    conversation.relation === "subagent" &&
    conversation.parentNativeId !== null
  ) {
    candidates.push(conversation.parentNativeId);
  }
  const rows = await trx
    .selectFrom("forgotten_conversations")
    .select("native_id")
    .where("agent", "=", conversation.agent)
    .where("native_id", "in", candidates)
    .execute();
  const forgotten = new Set(rows.map((row) => row.native_id));
  return candidates.find((nativeId) => forgotten.has(nativeId)) ?? null;
}

async function writeConversation(
  trx: Trx,
  conversation: ParsedConversation,
  links: ConversationLinks,
  now: number,
): Promise<number> {
  const metadata = {
    source_path: conversation.sourcePath,
    cwd: conversation.cwd,
    project_path: links.projectPath,
    agent_ui_session_id: links.agentUiSessionId,
    git_branch: conversation.gitBranch,
    git_sha: conversation.gitSha,
    title: conversation.title,
    started_at: conversation.startedAtMs,
    updated_at: conversation.updatedAtMs,
    parent_native_id: conversation.parentNativeId,
    relation: conversation.relation,
    turn_count: conversation.turns.length,
    indexed_at: now,
  };
  const { id } = await trx
    .insertInto("conversations")
    .values({
      ...metadata,
      agent: conversation.agent,
      native_id: conversation.nativeId,
      created_at: now,
    })
    .onConflict((conflict) =>
      conflict.columns(["agent", "native_id"]).doUpdateSet(metadata),
    )
    .returning("id")
    .executeTakeFirstOrThrow();

  await writeTurns(trx, id, conversation.turns, now);
  return id;
}

async function writeTurns(
  trx: Trx,
  conversationId: number,
  turns: readonly ParsedTurn[],
  now: number,
): Promise<void> {
  const existing = await trx
    .selectFrom("turns")
    .select([
      "id",
      "ordinal",
      "started_at",
      "file_paths",
      "commands",
      "source_line",
      "source_event_id",
      "content_hash",
    ])
    .where("conversation_id", "=", conversationId)
    .execute();
  const byOrdinal = new Map(existing.map((row) => [row.ordinal, row]));
  const seenOrdinals = new Set<number>();

  for (const turn of turns) {
    seenOrdinals.add(turn.ordinal);
    const metadata = {
      started_at: turn.startedAtMs,
      file_paths: JSON.stringify(turn.filePaths),
      commands: JSON.stringify(turn.commands),
      source_line: turn.sourceRef.line,
      source_event_id: turn.sourceRef.eventId,
    };
    const contentHash = turnContentHash(turn);
    const previous = byOrdinal.get(turn.ordinal);

    if (!previous) {
      await trx
        .insertInto("turns")
        .values({
          ...metadata,
          conversation_id: conversationId,
          ordinal: turn.ordinal,
          user_text: turn.userText,
          assistant_text: turn.assistantText,
          content_hash: contentHash,
          content_updated_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute();
    } else if (previous.content_hash !== contentHash) {
      await trx
        .updateTable("turns")
        .set({
          ...metadata,
          user_text: turn.userText,
          assistant_text: turn.assistantText,
          content_hash: contentHash,
          content_updated_at: now,
          updated_at: now,
        })
        .where("id", "=", previous.id)
        .execute();
    } else if (
      previous.started_at !== metadata.started_at ||
      previous.file_paths !== metadata.file_paths ||
      previous.commands !== metadata.commands ||
      previous.source_line !== metadata.source_line ||
      previous.source_event_id !== metadata.source_event_id
    ) {
      await trx
        .updateTable("turns")
        .set({ ...metadata, updated_at: now })
        .where("id", "=", previous.id)
        .execute();
    }
  }

  const staleIds = existing
    .filter((row) => !seenOrdinals.has(row.ordinal))
    .map((row) => row.id);
  for (let i = 0; i < staleIds.length; i += IN_CHUNK_SIZE) {
    await trx
      .deleteFrom("turns")
      .where("id", "in", staleIds.slice(i, i + IN_CHUNK_SIZE))
      .execute();
  }
}

/** Writes one parse result atomically and returns the source's new status. */
export async function applyParseOutcome(
  db: SessionMemoryDb,
  input: {
    source: TranscriptSource;
    outcome: ParseOutcome;
    links: ConversationLinks;
    parserVersion: number;
    now: number;
  },
): Promise<SessionMemorySourceStatus> {
  const { source, outcome, links, parserVersion, now } = input;
  const conversation = outcome.conversation;

  return await db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom("sources")
      .select("status")
      .where("path", "=", source.path)
      .executeTakeFirst();
    if (existing?.status === "forgotten") {
      return "forgotten";
    }

    if (conversation === null) {
      const readError = outcome.diagnostics.readError;
      const status = readError === null ? "empty" : "failed";
      await upsertSource(trx, source, parserVersion, now, {
        status,
        lastError: readError,
      });
      return status;
    }

    const forgottenNativeId = await findForgottenNativeId(trx, conversation);
    if (forgottenNativeId !== null) {
      await upsertSource(trx, source, parserVersion, now, {
        status: "forgotten",
        lastError: null,
        conversationId: null,
        forgottenNativeId,
      });
      return "forgotten";
    }

    if (conversation.origin === "text-generation") {
      await trx
        .deleteFrom("conversations")
        .where("agent", "=", conversation.agent)
        .where("native_id", "=", conversation.nativeId)
        .execute();
      await upsertSource(trx, source, parserVersion, now, {
        status: "excluded",
        lastError: null,
        conversationId: null,
      });
      return "excluded";
    }

    if (conversation.turns.length === 0) {
      await trx
        .deleteFrom("conversations")
        .where("agent", "=", conversation.agent)
        .where("native_id", "=", conversation.nativeId)
        .where("source_path", "=", source.path)
        .execute();
      await upsertSource(trx, source, parserVersion, now, {
        status: "empty",
        lastError: null,
        conversationId: null,
      });
      return "empty";
    }

    const conversationId = await writeConversation(
      trx,
      conversation,
      links,
      now,
    );
    await upsertSource(trx, source, parserVersion, now, {
      status: "indexed",
      lastError: null,
      conversationId,
    });
    return "indexed";
  });
}

export async function recordSourceFailure(
  db: SessionMemoryDb,
  input: {
    source: TranscriptSource;
    error: string;
    parserVersion: number;
    now: number;
  },
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await upsertSource(trx, input.source, input.parserVersion, input.now, {
      status: "failed",
      lastError: input.error,
    });
  });
}

export async function markSourcesMissing(
  db: SessionMemoryDb,
  paths: readonly string[],
  now: number,
): Promise<void> {
  for (let i = 0; i < paths.length; i += IN_CHUNK_SIZE) {
    await db
      .updateTable("sources")
      .set({ status: "missing", last_error: null, updated_at: now })
      .where("path", "in", paths.slice(i, i + IN_CHUNK_SIZE))
      .where("status", "not in", ["missing", "forgotten"])
      .execute();
  }
}

export interface LinkableConversation {
  agent: SessionMemoryAgent;
  nativeId: string;
  parentNativeId: string | null;
  relation: ParsedConversation["relation"];
  cwd: string | null;
}

export interface ConversationLinker {
  resolveProjectPath(cwd: string | null): Promise<string | null>;
  resolveAgentUiSessionId(conversation: LinkableConversation): string | null;
}

export async function resolveConversationLinks(
  linker: ConversationLinker,
  conversation: LinkableConversation,
): Promise<ConversationLinks> {
  return {
    projectPath: await linker.resolveProjectPath(conversation.cwd),
    agentUiSessionId: linker.resolveAgentUiSessionId(conversation),
  };
}

/** Recomputes project, agent-ui session and parent links; returns the number of rows changed. */
export async function relinkConversations(
  db: SessionMemoryDb,
  linker: ConversationLinker,
): Promise<number> {
  const rows = await db
    .selectFrom("conversations")
    .select([
      "id",
      "agent",
      "native_id",
      "parent_native_id",
      "relation",
      "cwd",
      "project_path",
      "agent_ui_session_id",
      "parent_conversation_id",
    ])
    .execute();
  const idsByNativeId = new Map(
    rows.map((row) => [`${row.agent}\u0000${row.native_id}`, row.id]),
  );

  const changes: {
    id: number;
    project_path: string | null;
    agent_ui_session_id: string | null;
    parent_conversation_id: number | null;
  }[] = [];
  for (const row of rows) {
    const links = await resolveConversationLinks(linker, {
      agent: row.agent,
      nativeId: row.native_id,
      parentNativeId: row.parent_native_id,
      relation: row.relation,
      cwd: row.cwd,
    });
    const parentId =
      row.parent_native_id === null
        ? null
        : (idsByNativeId.get(`${row.agent}\u0000${row.parent_native_id}`) ??
          null);
    if (
      links.projectPath !== row.project_path ||
      links.agentUiSessionId !== row.agent_ui_session_id ||
      parentId !== row.parent_conversation_id
    ) {
      changes.push({
        id: row.id,
        project_path: links.projectPath,
        agent_ui_session_id: links.agentUiSessionId,
        parent_conversation_id: parentId,
      });
    }
  }

  if (changes.length > 0) {
    await db.transaction().execute(async (trx) => {
      // Conversations forgotten since the read above must not be referenced.
      const remaining = new Set(
        (await trx.selectFrom("conversations").select("id").execute()).map(
          (row) => row.id,
        ),
      );
      for (const { id, ...values } of changes) {
        if (!remaining.has(id)) {
          continue;
        }
        await trx
          .updateTable("conversations")
          .set({
            ...values,
            parent_conversation_id:
              values.parent_conversation_id !== null &&
              remaining.has(values.parent_conversation_id)
                ? values.parent_conversation_id
                : null,
          })
          .where("id", "=", id)
          .execute();
      }
    });
  }
  return changes.length;
}

export async function readIndexCounts(
  db: SessionMemoryDb,
): Promise<SessionMemoryCounts> {
  const [sourceRows, conversationRows, turnRow] = await Promise.all([
    db
      .selectFrom("sources")
      .select(["status", (eb) => eb.fn.countAll<number>().as("count")])
      .groupBy("status")
      .execute(),
    db
      .selectFrom("conversations")
      .select(["agent", (eb) => eb.fn.countAll<number>().as("count")])
      .groupBy("agent")
      .execute(),
    db
      .selectFrom("turns")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow(),
  ]);

  const sources = Object.fromEntries(
    sessionMemorySourceStatuses.map((status) => [status, 0]),
  ) as SessionMemoryCounts["sources"];
  for (const row of sourceRows) {
    sources[row.status] = Number(row.count);
  }
  const conversations = Object.fromEntries(
    sessionMemoryAgents.map((agent) => [agent, 0]),
  ) as SessionMemoryCounts["conversations"];
  for (const row of conversationRows) {
    conversations[row.agent] = Number(row.count);
  }
  return { sources, conversations, turns: Number(turnRow.count) };
}
