import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("session_buffers")
    .addColumn("session_id", "text", (column) => column.primaryKey())
    .addColumn("offline_buffer", "text", (column) => column.notNull())
    .addColumn("updated_at", "integer", (column) => column.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("session_buffers").execute();
}
