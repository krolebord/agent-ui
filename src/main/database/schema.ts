export interface AppMetadataTable {
  key: string;
  value: string;
  updated_at: number;
}

export interface SessionBuffersTable {
  session_id: string;
  offline_buffer: string;
  updated_at: number;
}

export interface GlobalInstructionsTable {
  target: string;
  content: string;
  updated_at: number;
  last_pushed_at: number | null;
}

export interface AgentUiDatabase {
  app_metadata: AppMetadataTable;
  session_buffers: SessionBuffersTable;
  global_instructions: GlobalInstructionsTable;
}
