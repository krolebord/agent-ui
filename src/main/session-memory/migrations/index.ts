import type { Migration, MigrationProvider } from "kysely/migration";
import * as createIndex from "./0001_create_index";
import * as createChunks from "./0002_create_chunks";
import * as forgottenConversations from "./0003_forgotten_conversations";

const migrations: Record<string, Migration> = {
  "0001_create_index": createIndex,
  "0002_create_chunks": createChunks,
  "0003_forgotten_conversations": forgottenConversations,
};

export class SessionMemoryMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}
