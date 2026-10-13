import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("forgotten_conversations")
    .addColumn("agent", "text", (column) => column.notNull())
    .addColumn("native_id", "text", (column) => column.notNull())
    .addColumn("label", "text")
    .addColumn("forgotten_at", "integer", (column) => column.notNull())
    .addPrimaryKeyConstraint("forgotten_conversations_pk", [
      "agent",
      "native_id",
    ])
    .execute();

  await db.schema
    .alterTable("sources")
    .addColumn("forgotten_native_id", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("sources")
    .dropColumn("forgotten_native_id")
    .execute();
  await db.schema.dropTable("forgotten_conversations").execute();
}
