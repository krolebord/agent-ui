import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("session_buffers")
    .addColumn("initial_prompt", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("session_buffers")
    .dropColumn("initial_prompt")
    .execute();
}
