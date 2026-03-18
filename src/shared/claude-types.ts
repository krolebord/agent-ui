import { z } from "zod";
import type {
  CodexModelReasoningEffort,
  CodexPermissionMode,
} from "./codex-types";

export const claudeActivityStateSchema = z.enum([
  "idle",
  "working",
  "awaiting_approval",
  "awaiting_user_response",
  "unknown",
]);

export type ClaudeActivityState = z.infer<typeof claudeActivityStateSchema>;

export const claudeModelSchema = z.enum([
  "haiku",
  "sonnet",
  "sonnet[1m]",
  "opus",
]);

export type ClaudeModel = z.infer<typeof claudeModelSchema>;

export const claudePermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "plan",
  "yolo",
]);

export type ClaudePermissionMode = z.infer<typeof claudePermissionModeSchema>;

export const claudeEffortSchema = z.enum(["low", "medium", "high"]);

export type ClaudeEffort = z.infer<typeof claudeEffortSchema>;

export interface LocalClaudeProjectSettings {
  defaultModel?: ClaudeModel;
  defaultPermissionMode?: ClaudePermissionMode;
  defaultEffort?: ClaudeEffort;
  defaultHaikuModelOverride?: ClaudeModel;
  defaultSubagentModelOverride?: ClaudeModel;
  defaultSystemPrompt?: string;
}

export interface LocalCodexProjectSettings {
  model?: string;
  permissionMode?: CodexPermissionMode;
  modelReasoningEffort?: CodexModelReasoningEffort;
  fastMode?: boolean;
  configOverrides?: string;
}

export type CursorAgentMode = "plan" | "ask";
export type CursorAgentPermissionMode = "default" | "yolo";

export interface LocalCursorProjectSettings {
  model?: string;
  mode?: CursorAgentMode;
  permissionMode?: CursorAgentPermissionMode;
}

export interface GitDiffStats {
  addedLines: number;
  deletedLines: number;
}

export interface ClaudeProject {
  path: string;
  collapsed: boolean;
  alias?: string;
  gitBranch?: string;
  gitDiffStats?: GitDiffStats;
  worktreeOriginPath?: string;
  localClaude?: LocalClaudeProjectSettings;
  localCodex?: LocalCodexProjectSettings;
  localCursor?: LocalCursorProjectSettings;
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
