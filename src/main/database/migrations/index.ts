import type { Migration, MigrationProvider } from "kysely/migration";
import * as createAppMetadata from "./0001_create_app_metadata";

const migrations: Record<string, Migration> = {
  "0001_create_app_metadata": createAppMetadata,
};

export class AppMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}
