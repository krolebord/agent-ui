import { access, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { afterEach, describe, expect, it } from "vitest";
import {
  DATABASE_FILENAME,
  DatabaseService,
} from "../../src/main/database/database-service";
import { AppMigrationProvider } from "../../src/main/database/migrations";

describe("DatabaseService", () => {
  const tempDirs: string[] = [];

  async function createTempDir() {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-ui-db-"));
    tempDirs.push(tempDir);
    return tempDir;
  }

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("creates the database, applies migrations, and configures SQLite", async () => {
    const userDataPath = await createTempDir();
    const service = await DatabaseService.create(userDataPath);

    expect(service.path).toBe(path.join(userDataPath, DATABASE_FILENAME));
    await expect(access(service.path)).resolves.toBeUndefined();

    const tables = await sql<{ name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
      ORDER BY name
    `.execute(service.db);
    expect(tables.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "app_metadata",
        "global_instructions",
        "kysely_migration",
        "kysely_migration_lock",
        "session_buffers",
      ]),
    );

    const foreignKeys = await sql<{ foreign_keys: number }>`
      PRAGMA foreign_keys
    `.execute(service.db);
    const journalMode = await sql<{ journal_mode: string }>`
      PRAGMA journal_mode
    `.execute(service.db);
    const busyTimeout = await sql<{ timeout: number }>`
      PRAGMA busy_timeout
    `.execute(service.db);

    expect(foreignKeys.rows[0]?.foreign_keys).toBe(1);
    expect(journalMode.rows[0]?.journal_mode).toBe("wal");
    expect(busyTimeout.rows[0]?.timeout).toBe(5_000);

    if (process.platform !== "win32") {
      expect((await stat(service.path)).mode & 0o777).toBe(0o600);
      for (const suffix of ["-wal", "-shm"]) {
        const sidecarPath = `${service.path}${suffix}`;
        await expect(access(sidecarPath)).resolves.toBeUndefined();
        expect((await stat(sidecarPath)).mode & 0o777).toBe(0o600);
      }
    }

    await service.close();
  });

  it("reopens an existing database without rerunning migrations", async () => {
    const userDataPath = await createTempDir();
    const first = await DatabaseService.create(userDataPath);
    await first.db
      .insertInto("app_metadata")
      .values({ key: "test", value: "persisted", updated_at: 1 })
      .execute();
    await first.close();

    const second = await DatabaseService.create(userDataPath);
    const metadata = await second.db
      .selectFrom("app_metadata")
      .selectAll()
      .where("key", "=", "test")
      .executeTakeFirst();
    const appliedMigrations = await sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM kysely_migration
    `.execute(second.db);

    expect(metadata).toEqual({
      key: "test",
      value: "persisted",
      updated_at: 1,
    });
    // Compare against the provider so adding a migration does not fail this.
    const expectedMigrations = Object.keys(
      await new AppMigrationProvider().getMigrations(),
    ).length;
    expect(appliedMigrations.rows[0]?.count).toBe(expectedMigrations);

    await second.close();
    await expect(second.close()).resolves.toBeUndefined();
  });

  it("closes the connection when a migration fails", async () => {
    const userDataPath = await createTempDir();
    const failingProvider: MigrationProvider = {
      async getMigrations() {
        return {
          "0001_failure": {
            async up() {
              throw new Error("migration exploded");
            },
          },
        };
      },
    };

    await expect(
      DatabaseService.create(userDataPath, {
        migrationProvider: failingProvider,
      }),
    ).rejects.toThrow("Failed to migrate the Agent UI database");

    await expect(
      rm(path.join(userDataPath, DATABASE_FILENAME), { force: true }),
    ).resolves.toBeUndefined();
  });
});
