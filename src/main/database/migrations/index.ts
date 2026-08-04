import type { Migration, MigrationProvider } from "kysely/migration";
import * as createAppMetadata from "./0001_create_app_metadata";
import * as createSessionBuffers from "./0002_create_session_buffers";

const migrations: Record<string, Migration> = {
  "0001_create_app_metadata": createAppMetadata,
  "0002_create_session_buffers": createSessionBuffers,
};

export class AppMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}
