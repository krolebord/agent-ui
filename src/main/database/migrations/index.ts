import type { Migration, MigrationProvider } from "kysely/migration";
import * as createAppMetadata from "./0001_create_app_metadata";
import * as createSessionBuffers from "./0002_create_session_buffers";
import * as createGlobalInstructions from "./0003_create_global_instructions";
import * as addSessionInitialPrompt from "./0004_add_session_initial_prompt";

const migrations: Record<string, Migration> = {
  "0001_create_app_metadata": createAppMetadata,
  "0002_create_session_buffers": createSessionBuffers,
  "0003_create_global_instructions": createGlobalInstructions,
  "0004_add_session_initial_prompt": addSessionInitialPrompt,
};

export class AppMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}
