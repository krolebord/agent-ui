import type {
  SessionMemoryAgent,
  SessionMemoryClearIndexPreview,
  SessionMemoryForgottenConversation,
} from "@shared/session-memory";
import { sql } from "kysely";
import type { SessionMemoryDb } from "./database";
import { getOpeningUserTexts } from "./queries";

const LABEL_MAX_CHARS = 120;

export interface ForgottenConversationResult {
  agent: SessionMemoryAgent;
  nativeId: string;
  /** The conversation itself plus its subagents. */
  deletedConversationIds: number[];
}

function toLabel(text: string | null | undefined): string | null {
  const collapsed = text?.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return null;
  }
  return collapsed.length > LABEL_MAX_CHARS
    ? `${collapsed.slice(0, LABEL_MAX_CHARS - 1)}…`
    : collapsed;
}

async function checkpointWal(db: SessionMemoryDb): Promise<void> {
  await sql`PRAGMA wal_checkpoint(TRUNCATE)`.execute(db);
}

/**
 * Deletes a conversation with its subagents (turns and chunks cascade) and
 * records it so sync never stores it again. Forks keep their rows; their
 * parent link is cleared by the foreign key. Returns null when it is not
 * indexed.
 */
export async function forgetConversation(
  db: SessionMemoryDb,
  input: { id: number; now: number },
): Promise<ForgottenConversationResult | null> {
  const result = await db.transaction().execute(async (trx) => {
    const root = await trx
      .selectFrom("conversations")
      .select(["id", "agent", "native_id", "title"])
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (!root) {
      return null;
    }

    const ids = [root.id];
    const seen = new Set([root.native_id]);
    let parents = [root.native_id];
    while (parents.length > 0) {
      const children = await trx
        .selectFrom("conversations")
        .select(["id", "native_id"])
        .where("agent", "=", root.agent)
        .where("relation", "=", "subagent")
        .where("parent_native_id", "in", parents)
        .execute();
      parents = [];
      for (const child of children) {
        if (!seen.has(child.native_id)) {
          seen.add(child.native_id);
          ids.push(child.id);
          parents.push(child.native_id);
        }
      }
    }

    const opening = await getOpeningUserTexts(
      trx,
      [root.id],
      LABEL_MAX_CHARS * 4,
    );
    const label = toLabel(root.title) ?? toLabel(opening.get(root.id));
    await trx
      .insertInto("forgotten_conversations")
      .values({
        agent: root.agent,
        native_id: root.native_id,
        label,
        forgotten_at: input.now,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["agent", "native_id"])
          .doUpdateSet({ label, forgotten_at: input.now }),
      )
      .execute();

    await trx
      .updateTable("sources")
      .set({
        status: "forgotten",
        forgotten_native_id: root.native_id,
        conversation_id: null,
        last_error: null,
        updated_at: input.now,
      })
      .where("conversation_id", "in", ids)
      .execute();

    // Overwrite the freed pages so the text does not linger in the file.
    await sql`PRAGMA secure_delete = ON`.execute(trx);
    try {
      await trx.deleteFrom("conversations").where("id", "in", ids).execute();
    } finally {
      await sql`PRAGMA secure_delete = OFF`.execute(trx);
    }

    return {
      agent: root.agent,
      nativeId: root.native_id,
      deletedConversationIds: ids,
    };
  });
  if (result) {
    await checkpointWal(db);
  }
  return result;
}

export async function listForgottenConversations(
  db: SessionMemoryDb,
): Promise<SessionMemoryForgottenConversation[]> {
  const rows = await db
    .selectFrom("forgotten_conversations")
    .selectAll()
    .orderBy("forgotten_at", "desc")
    .orderBy("native_id", "asc")
    .execute();
  return rows.map((row) => ({
    agent: row.agent,
    nativeId: row.native_id,
    label: row.label,
    forgottenAt: row.forgotten_at,
  }));
}

/**
 * Drops the forgotten entry and the sources suppressed by it, so the next
 * sync treats those files as new. Returns false when nothing was forgotten.
 */
export async function restoreForgottenConversation(
  db: SessionMemoryDb,
  input: { agent: SessionMemoryAgent; nativeId: string },
): Promise<boolean> {
  return await db.transaction().execute(async (trx) => {
    const deleted = await trx
      .deleteFrom("forgotten_conversations")
      .where("agent", "=", input.agent)
      .where("native_id", "=", input.nativeId)
      .executeTakeFirst();
    if (deleted.numDeletedRows === 0n) {
      return false;
    }
    await trx
      .deleteFrom("sources")
      .where("agent", "=", input.agent)
      .where("status", "=", "forgotten")
      .where("forgotten_native_id", "=", input.nativeId)
      .execute();
    return true;
  });
}

export async function readClearIndexPreview(
  db: SessionMemoryDb,
): Promise<SessionMemoryClearIndexPreview> {
  const result = await sql<{
    conversations: number;
    without_transcript: number | null;
  }>`
    SELECT
      count(*) AS conversations,
      sum(NOT EXISTS (
        SELECT 1 FROM sources s
        WHERE s.conversation_id = c.id AND s.status <> 'missing'
      )) AS without_transcript
    FROM conversations c
  `.execute(db);
  const row = result.rows[0];
  return {
    conversations: Number(row?.conversations ?? 0),
    conversationsWithoutTranscript: Number(row?.without_transcript ?? 0),
  };
}

/** Deletes everything derived from transcripts; forgotten entries stay. */
export async function clearIndex(db: SessionMemoryDb): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("chunks").execute();
    await trx.deleteFrom("turn_chunk_state").execute();
    await trx.deleteFrom("turns").execute();
    await trx.deleteFrom("sources").execute();
    await trx
      .updateTable("conversations")
      .set({ parent_conversation_id: null })
      .execute();
    await trx.deleteFrom("conversations").execute();
  });
}

export async function vacuumDatabase(db: SessionMemoryDb): Promise<void> {
  await sql`VACUUM`.execute(db);
  await checkpointWal(db);
}
