import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("global_instructions")
    .addColumn("target", "text", (column) => column.primaryKey())
    .addColumn("content", "text", (column) => column.notNull())
    .addColumn("updated_at", "integer", (column) => column.notNull())
    .addColumn("last_pushed_at", "integer")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("global_instructions").execute();
}
