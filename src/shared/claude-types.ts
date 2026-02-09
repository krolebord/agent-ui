export const CLAUDE_IPC_CHANNELS = {
  selectFolder: "claude:select-folder",
  getSessions: "claude:get-sessions",
  addProject: "claude:add-project",
  setProjectCollapsed: "claude:set-project-collapsed",
  setProjectDefaults: "claude:set-project-defaults",
  startSession: "claude:start-session",
  stopSession: "claude:stop-session",
  deleteSession: "claude:delete-session",
  deleteProject: "claude:delete-project",
  setActiveSession: "claude:set-active-session",
  writeSession: "claude:write-session",
  resizeSession: "claude:resize-session",
  sessionData: "claude:session-data",
  sessionExit: "claude:session-exit",
  sessionError: "claude:session-error",
  sessionUpdated: "claude:session-updated",
  activeSessionChanged: "claude:active-session-changed",
  getUsage: "claude:get-usage",
  openLogFolder: "claude:open-log-folder",
} as const;

export type SessionId = string;

export type ClaudeModel = "opus" | "sonnet" | "haiku";

export type ClaudePermissionMode = "default" | "acceptEdits" | "plan" | "yolo";

export type ClaudeSessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopped"
  | "error";

export type ClaudeActivityState =
  | "idle"
  | "working"
  | "awaiting_approval"
  | "awaiting_user_response"
  | "unknown";

export interface ClaudeProject {
  path: string;
  collapsed: boolean;
  defaultModel?: ClaudeModel;
  defaultPermissionMode?: ClaudePermissionMode;
}

export interface ClaudeSessionSnapshot {
  sessionId: SessionId;
  cwd: string;
  sessionName: string | null;
  permissionMode?: ClaudePermissionMode;
  status: ClaudeSessionStatus;
  activityState: ClaudeActivityState;
  activityWarning: string | null;
  lastError: string | null;
  createdAt: string;
  lastActivityAt: string;
}

export interface ClaudeSessionsSnapshot {
  projects: ClaudeProject[];
  sessions: ClaudeSessionSnapshot[];
  activeSessionId: SessionId | null;
}

export interface AddClaudeProjectInput {
  path: string;
}

export interface SetClaudeProjectCollapsedInput {
  path: string;
  collapsed: boolean;
}

export interface SetClaudeProjectDefaultsInput {
  path: string;
  defaultModel?: ClaudeModel;
  defaultPermissionMode?: ClaudePermissionMode;
}

export interface StartClaudeSessionInput {
  cwd: string;
  cols: number;
  rows: number;
  resumeSessionId?: SessionId;
  forkSessionId?: SessionId;
  sessionName?: string | null;
  permissionMode?: ClaudePermissionMode;
  model?: ClaudeModel;
  initialPrompt?: string;
}

export type StartClaudeSessionResult =
  | {
      ok: true;
      sessionId: SessionId;
      snapshot: ClaudeSessionsSnapshot;
    }
  | {
      ok: false;
      message: string;
    };

export interface StopClaudeSessionInput {
  sessionId: SessionId;
}

export interface DeleteClaudeProjectInput {
  path: string;
}

export interface DeleteClaudeSessionInput {
  sessionId: SessionId;
}

export interface SetActiveSessionInput {
  sessionId: SessionId;
}

export interface WriteClaudeSessionInput {
  sessionId: SessionId;
  data: string;
}

export interface ResizeClaudeSessionInput {
  sessionId: SessionId;
  cols: number;
  rows: number;
}

export interface ClaudeSessionDataEvent {
  sessionId: SessionId;
  chunk: string;
}

export interface ClaudeSessionExitEvent {
  sessionId: SessionId;
  exitCode: number | null;
  signal?: number;
}

export interface ClaudeSessionErrorEvent {
  sessionId: SessionId;
  message: string;
}

export interface ClaudeSessionUpdatedEvent {
  sessionId: SessionId;
  updates: Partial<
    Pick<
      ClaudeSessionSnapshot,
      | "status"
      | "activityState"
      | "activityWarning"
      | "sessionName"
      | "lastActivityAt"
    >
  >;
}

export interface ClaudeActiveSessionChangedEvent {
  activeSessionId: SessionId | null;
}

export interface ClaudeHookEvent {
  timestamp: string;
  session_id: string;
  hook_event_name: string;
  cwd?: string;
  prompt?: string;
  transcript_path?: string;
  notification_type?: string;
  tool_name?: string;
  reason?: string;
  stop_hook_active?: boolean;
}

export interface ClaudeUsageBucket {
  utilization: number;
  resets_at: string | null;
}

export interface ClaudeExtraUsage {
  is_enabled: boolean;
  monthly_limit: number;
  used_credits: number;
  utilization: number;
}

export interface ClaudeUsageData {
  five_hour: ClaudeUsageBucket | null;
  seven_day: ClaudeUsageBucket | null;
  seven_day_sonnet: ClaudeUsageBucket | null;
  extra_usage: ClaudeExtraUsage | null;
}

export type ClaudeUsageResult =
  | { ok: true; usage: ClaudeUsageData }
  | { ok: false; message: string };

export interface ClaudeDesktopApi {
  selectFolder: () => Promise<string | null>;
  getSessions: () => Promise<ClaudeSessionsSnapshot>;
  addClaudeProject: (
    input: AddClaudeProjectInput,
  ) => Promise<ClaudeSessionsSnapshot>;
  setClaudeProjectCollapsed: (
    input: SetClaudeProjectCollapsedInput,
  ) => Promise<ClaudeSessionsSnapshot>;
  setClaudeProjectDefaults: (
    input: SetClaudeProjectDefaultsInput,
  ) => Promise<ClaudeSessionsSnapshot>;
  startClaudeSession: (
    input: StartClaudeSessionInput,
  ) => Promise<StartClaudeSessionResult>;
  stopClaudeSession: (input: StopClaudeSessionInput) => Promise<void>;
  deleteClaudeProject: (
    input: DeleteClaudeProjectInput,
  ) => Promise<ClaudeSessionsSnapshot>;
  deleteClaudeSession: (input: DeleteClaudeSessionInput) => Promise<void>;
  setActiveSession: (input: SetActiveSessionInput) => Promise<void>;
  writeToClaudeSession: (input: WriteClaudeSessionInput) => void;
  resizeClaudeSession: (input: ResizeClaudeSessionInput) => void;
  onClaudeSessionData: (
    callback: (payload: ClaudeSessionDataEvent) => void,
  ) => () => void;
  onClaudeSessionExit: (
    callback: (payload: ClaudeSessionExitEvent) => void,
  ) => () => void;
  onClaudeSessionError: (
    callback: (payload: ClaudeSessionErrorEvent) => void,
  ) => () => void;
  onClaudeSessionUpdated: (
    callback: (payload: ClaudeSessionUpdatedEvent) => void,
  ) => () => void;
  onClaudeActiveSessionChanged: (
    callback: (payload: ClaudeActiveSessionChangedEvent) => void,
  ) => () => void;
  getUsage: () => Promise<ClaudeUsageResult>;
  openLogFolder: () => Promise<void>;
}
