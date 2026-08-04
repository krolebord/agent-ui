import type { Kysely } from "kysely";
import log from "../logger";
import type { AgentUiDatabase } from "./schema";

// Keeps orphan cleanup under SQLite's bound parameter limit.
const DELETE_CHUNK_SIZE = 500;

/**
 * Terminal scrollback for stopped sessions. Failures are logged and swallowed:
 * losing scrollback must never break the state update that triggered the write.
 */
export interface SessionBufferStore {
  get(sessionId: string): Promise<string | undefined>;
  set(sessionId: string, offlineBuffer: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
  deleteOrphans(knownSessionIds: string[]): Promise<number>;
}

export class SqliteSessionBufferStore implements SessionBufferStore {
  constructor(private readonly db: Kysely<AgentUiDatabase>) {}

  async get(sessionId: string): Promise<string | undefined> {
    try {
      const row = await this.db
        .selectFrom("session_buffers")
        .select("offline_buffer")
        .where("session_id", "=", sessionId)
        .executeTakeFirst();

      return row?.offline_buffer;
    } catch (error) {
      log.error("Failed to read session buffer", { sessionId, error });
      return undefined;
    }
  }

  async set(sessionId: string, offlineBuffer: string): Promise<void> {
    try {
      const updatedAt = Date.now();
      await this.db
        .insertInto("session_buffers")
        .values({
          session_id: sessionId,
          offline_buffer: offlineBuffer,
          updated_at: updatedAt,
        })
        .onConflict((conflict) =>
          conflict.column("session_id").doUpdateSet({
            offline_buffer: offlineBuffer,
            updated_at: updatedAt,
          }),
        )
        .execute();
    } catch (error) {
      log.error("Failed to write session buffer", { sessionId, error });
    }
  }

  async delete(sessionId: string): Promise<void> {
    try {
      await this.db
        .deleteFrom("session_buffers")
        .where("session_id", "=", sessionId)
        .execute();
    } catch (error) {
      log.error("Failed to delete session buffer", { sessionId, error });
    }
  }

  async deleteOrphans(knownSessionIds: string[]): Promise<number> {
    // An empty list is also what a failed hydration looks like, so refuse it
    // rather than wipe every buffer.
    if (knownSessionIds.length === 0) {
      return 0;
    }

    try {
      const orphanIds = await this.db
        .selectFrom("session_buffers")
        .select("session_id")
        .where("session_id", "not in", knownSessionIds)
        .execute();

      let deleted = 0;
      for (let i = 0; i < orphanIds.length; i += DELETE_CHUNK_SIZE) {
        const chunk = orphanIds
          .slice(i, i + DELETE_CHUNK_SIZE)
          .map((row) => row.session_id);
        const result = await this.db
          .deleteFrom("session_buffers")
          .where("session_id", "in", chunk)
          .executeTakeFirst();
        deleted += Number(result.numDeletedRows ?? 0n);
      }

      return deleted;
    } catch (error) {
      log.error("Failed to delete orphaned session buffers", error);
      return 0;
    }
  }
}

/** Fallback for managers constructed without a database, and for tests. */
export function createInMemorySessionBufferStore(): SessionBufferStore {
  const buffers = new Map<string, string>();

  return {
    async get(sessionId) {
      return buffers.get(sessionId);
    },
    async set(sessionId, offlineBuffer) {
      buffers.set(sessionId, offlineBuffer);
    },
    async delete(sessionId) {
      buffers.delete(sessionId);
    },
    async deleteOrphans(knownSessionIds) {
      if (knownSessionIds.length === 0) {
        return 0;
      }
      const known = new Set(knownSessionIds);
      let deleted = 0;
      for (const sessionId of [...buffers.keys()]) {
        if (!known.has(sessionId)) {
          buffers.delete(sessionId);
          deleted++;
        }
      }
      return deleted;
    },
  };
}
