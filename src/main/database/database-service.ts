import { chmod, mkdir, open } from "node:fs/promises";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { type MigrationProvider, Migrator } from "kysely/migration";
import { AppMigrationProvider } from "./migrations";
import type { AgentUiDatabase } from "./schema";

export const DATABASE_FILENAME = "agent-ui.sqlite3";

interface CreateDatabaseOptions {
  migrationProvider?: MigrationProvider;
}

export class DatabaseService {
  private closePromise: Promise<void> | null = null;

  private constructor(
    readonly path: string,
    readonly db: Kysely<AgentUiDatabase>,
  ) {}

  static async create(
    userDataPath: string,
    options: CreateDatabaseOptions = {},
  ): Promise<DatabaseService> {
    await mkdir(userDataPath, { recursive: true });

    const databasePath = path.join(userDataPath, DATABASE_FILENAME);
    // Pre-create with a restrictive mode. SQLite derives WAL/SHM sidecar
    // permissions from the database file, avoiding a world-readable window.
    const databaseFile = await open(databasePath, "a", 0o600);
    try {
      await databaseFile.chmod(0o600);
    } finally {
      await databaseFile.close();
    }

    const sqlite = new BetterSqlite3(databasePath);
    let db: Kysely<AgentUiDatabase> | null = null;

    try {
      sqlite.pragma("busy_timeout = 5000");
      sqlite.pragma("foreign_keys = ON");
      sqlite.pragma("journal_mode = WAL");
      sqlite.pragma("synchronous = NORMAL");

      db = new Kysely<AgentUiDatabase>({
        dialect: new SqliteDialect({ database: sqlite }),
      });

      const migrator = new Migrator({
        db,
        provider: options.migrationProvider ?? new AppMigrationProvider(),
      });
      const migrationResult = await migrator.migrateToLatest();
      if (migrationResult.error) {
        throw new Error("Failed to migrate the Agent UI database", {
          cause: migrationResult.error,
        });
      }

      // The database can contain prompts, terminal output, and credentials in
      // future migrations. Do not rely on the process umask for its mode.
      await chmod(databasePath, 0o600);

      return new DatabaseService(databasePath, db);
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
