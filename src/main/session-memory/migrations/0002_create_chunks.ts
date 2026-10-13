import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("turn_chunk_state")
    .addColumn("turn_id", "integer", (column) =>
      column.primaryKey().references("turns.id").onDelete("cascade"),
    )
    .addColumn("content_hash", "text", (column) => column.notNull())
    .addColumn("title", "text")
    .addColumn("chunker_version", "integer", (column) => column.notNull())
    .addColumn("model_id", "text", (column) => column.notNull())
    .addColumn("chunk_count", "integer", (column) => column.notNull())
    .addColumn("error", "text")
    .addColumn("chunked_at", "integer", (column) => column.notNull())
    .execute();

  await db.schema
    .createTable("chunks")
    .addColumn("id", "integer", (column) => column.primaryKey().autoIncrement())
    .addColumn("turn_id", "integer", (column) =>
      column.notNull().references("turns.id").onDelete("cascade"),
    )
    .addColumn("chunk_index", "integer", (column) => column.notNull())
    .addColumn("model_id", "text", (column) => column.notNull())
    .addColumn("embed_hash", "text", (column) => column.notNull())
    .addColumn("token_count", "integer", (column) => column.notNull())
    .addColumn("embedded_at", "integer")
    .addColumn("error", "text")
    // Ahead of `text` so a search scan does not walk the text's overflow pages.
    .addColumn("vector", "blob")
    .addColumn("text", "text", (column) => column.notNull())
    .addUniqueConstraint("chunks_turn_chunk_index_unique", [
      "turn_id",
      "chunk_index",
    ])
    .execute();

  await db.schema
    .createIndex("chunks_embed_hash_idx")
    .on("chunks")
    .columns(["embed_hash", "model_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("chunks").execute();
  await db.schema.dropTable("turn_chunk_state").execute();
}
