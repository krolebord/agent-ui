import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("conversations")
    .addColumn("id", "integer", (column) => column.primaryKey().autoIncrement())
    .addColumn("agent", "text", (column) => column.notNull())
    .addColumn("native_id", "text", (column) => column.notNull())
    .addColumn("source_path", "text", (column) => column.notNull())
    .addColumn("cwd", "text")
    .addColumn("project_path", "text")
    .addColumn("agent_ui_session_id", "text")
    .addColumn("git_branch", "text")
    .addColumn("git_sha", "text")
    .addColumn("title", "text")
    .addColumn("started_at", "integer")
    .addColumn("updated_at", "integer")
    .addColumn("parent_native_id", "text")
    .addColumn("parent_conversation_id", "integer", (column) =>
      column.references("conversations.id").onDelete("set null"),
    )
    .addColumn("relation", "text", (column) => column.notNull())
    .addColumn("turn_count", "integer", (column) => column.notNull())
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addColumn("indexed_at", "integer", (column) => column.notNull())
    .addUniqueConstraint("conversations_agent_native_id_unique", [
      "agent",
      "native_id",
    ])
    .execute();

  for (const columns of [
    ["agent", "updated_at"],
    ["project_path", "updated_at"],
    ["cwd"],
    ["started_at"],
    ["updated_at"],
    ["agent_ui_session_id"],
    ["parent_native_id"],
    ["parent_conversation_id"],
  ]) {
    await db.schema
      .createIndex(`conversations_${columns.join("_")}_idx`)
      .on("conversations")
      .columns(columns)
      .execute();
  }

  await db.schema
    .createTable("turns")
    .addColumn("id", "integer", (column) => column.primaryKey().autoIncrement())
    .addColumn("conversation_id", "integer", (column) =>
      column.notNull().references("conversations.id").onDelete("cascade"),
    )
    .addColumn("ordinal", "integer", (column) => column.notNull())
    .addColumn("started_at", "integer")
    .addColumn("user_text", "text", (column) => column.notNull())
    .addColumn("assistant_text", "text", (column) => column.notNull())
    .addColumn("file_paths", "text", (column) => column.notNull())
    .addColumn("commands", "text", (column) => column.notNull())
    .addColumn("source_line", "integer")
    .addColumn("source_event_id", "text")
    .addColumn("content_hash", "text", (column) => column.notNull())
    .addColumn("content_updated_at", "integer", (column) => column.notNull())
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addColumn("updated_at", "integer", (column) => column.notNull())
    .addUniqueConstraint("turns_conversation_ordinal_unique", [
      "conversation_id",
      "ordinal",
    ])
    .execute();

  await db.schema
    .createIndex("turns_started_at_idx")
    .on("turns")
    .column("started_at")
    .execute();
  await db.schema
    .createIndex("turns_content_updated_at_idx")
    .on("turns")
    .column("content_updated_at")
    .execute();

  await db.schema
    .createTable("sources")
    .addColumn("path", "text", (column) => column.primaryKey())
    .addColumn("agent", "text", (column) => column.notNull())
    .addColumn("fingerprint", "text", (column) => column.notNull())
    .addColumn("parser_version", "integer", (column) => column.notNull())
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("last_error", "text")
    .addColumn("conversation_id", "integer", (column) =>
      column.references("conversations.id").onDelete("set null"),
    )
    .addColumn("created_at", "integer", (column) => column.notNull())
    .addColumn("updated_at", "integer", (column) => column.notNull())
    .execute();

  await db.schema
    .createIndex("sources_conversation_id_idx")
    .on("sources")
    .column("conversation_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("sources").execute();
  await db.schema.dropTable("turns").execute();
  await db.schema.dropTable("conversations").execute();
}
