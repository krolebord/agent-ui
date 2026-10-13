import { chmod, mkdir, open } from "node:fs/promises";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { type MigrationProvider, Migrator } from "kysely/migration";
import * as sqliteVec from "sqlite-vec";
import log from "../../logger";
import { SessionMemoryMigrationProvider } from "../migrations";
import type { SessionMemoryDatabaseSchema } from "./schema";

export const SESSION_MEMORY_DATABASE_FILENAME = "session-memory.sqlite3";

export type SessionMemoryDb = Kysely<SessionMemoryDatabaseSchema>;

interface CreateSessionMemoryDatabaseOptions {
  migrationProvider?: MigrationProvider;
  loadVectorExtension?: (sqlite: BetterSqlite3.Database) => void;
}

function loadSqliteVec(sqlite: BetterSqlite3.Database): void {
  sqliteVec.load(sqlite);
}

export class SessionMemoryDatabase {
  private closePromise: Promise<void> | null = null;

  private constructor(
    readonly path: string,
    readonly db: SessionMemoryDb,
    /** False when sqlite-vec could not be loaded; the text index still works. */
    readonly vectorSearch: boolean,
  ) {}

  static async create(
    userDataPath: string,
    options: CreateSessionMemoryDatabaseOptions = {},
  ): Promise<SessionMemoryDatabase> {
    await mkdir(userDataPath, { recursive: true });

    const databasePath = path.join(
      userDataPath,
      SESSION_MEMORY_DATABASE_FILENAME,
    );
    const databaseFile = await open(databasePath, "a", 0o600);
    try {
      await databaseFile.chmod(0o600);
    } finally {
      await databaseFile.close();
    }

    const sqlite = new BetterSqlite3(databasePath);
    let db: SessionMemoryDb | null = null;

    try {
      sqlite.pragma("busy_timeout = 5000");
      sqlite.pragma("foreign_keys = ON");
      sqlite.pragma("journal_mode = WAL");
      sqlite.pragma("synchronous = NORMAL");

      let vectorSearch = false;
      try {
        (options.loadVectorExtension ?? loadSqliteVec)(sqlite);
        vectorSearch = true;
      } catch (error) {
        log.warn("Failed to load sqlite-vec into the session memory database", {
          error,
        });
      }

      db = new Kysely<SessionMemoryDatabaseSchema>({
        dialect: new SqliteDialect({ database: sqlite }),
      });

      const migrator = new Migrator({
        db,
        provider:
          options.migrationProvider ?? new SessionMemoryMigrationProvider(),
      });
      const migrationResult = await migrator.migrateToLatest();
      if (migrationResult.error) {
        throw new Error("Failed to migrate the session memory database", {
          cause: migrationResult.error,
        });
      }

      await chmod(databasePath, 0o600);

      return new SessionMemoryDatabase(databasePath, db, vectorSearch);
    } catch (error) {
      if (db) {
        await db.destroy();
      } else {
        sqlite.close();
      }
      throw error;
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.db.destroy();
    return this.closePromise;
  }
}
