import { z } from "zod";

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
  "fable",
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

export type CursorAgentMode = "plan" | "ask";
export type CursorAgentPermissionMode = "default" | "yolo";

export interface GitDiffStats {
  addedLines: number;
  deletedLines: number;
}

export interface GitUpstreamDiffStats {
  upstreamBranch: string;
  aheadCommits: number;
  behindCommits: number;
}

export type ProjectDeletionToastKind = "warning" | "error";

export interface ProjectDeletionToast {
  kind: ProjectDeletionToastKind;
  message: string;
}

export interface ClaudeProject {
  path: string;
  collapsed: boolean;
  alias?: string;
  gitBranch?: string;
  gitDiffStats?: GitDiffStats;
  gitUpstreamDiffStats?: GitUpstreamDiffStats;
  worktreeOriginPath?: string;
  worktreeSetupCommands?: string;
  /** Ephemeral: UI + main reject mutations while a worktree delete is in flight */
  interactionDisabled?: boolean;
  /** Ephemeral: one-shot toast payload for renderer (not persisted) */
  deletionToast?: ProjectDeletionToast;
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
