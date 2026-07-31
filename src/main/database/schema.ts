export interface AppMetadataTable {
  key: string;
  value: string;
  updated_at: number;
}

/**
 * Kysely's compile-time view of the application database.
 *
 * Feature tables should be added here in the same change as their migration.
 */
export interface AgentUiDatabase {
  app_metadata: AppMetadataTable;
}
