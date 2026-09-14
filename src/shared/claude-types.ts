import { z } from "zod";

export const claudeActivityStateSchema = z.enum([
  "idle",
  "working",
  "awaiting_approval",
  "awaiting_user_response",
  "unknown",
]);

export type ClaudeActivityState = z.infer<typeof claudeActivityStateSchema>;

export const claudeModelSchema = z.string().trim().min(1);

export type ClaudeModel = z.infer<typeof claudeModelSchema>;

export const claudePermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "plan",
  "yolo",
]);

export type ClaudePermissionMode = z.infer<typeof claudePermissionModeSchema>;

export const claudeEffortSchema = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

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

export interface GitHistoryCommit {
  hash: string;
  parentHashes: string[];
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  refs: string[];
  unpushed: boolean;
}

export interface GitHistoryPage {
  commits: GitHistoryCommit[];
  nextCursor: string | null;
}

export type ProjectDeletionToastKind = "warning" | "error";

export interface ProjectDeletionToast {
  kind: ProjectDeletionToastKind;
  message: string;
}

export interface ClaudeProject {
  path: string;
  collapsed: boolean;
  hidden?: boolean;
  alias?: string;
  gitBranch?: string;
  gitDiffStats?: GitDiffStats;
  gitUpstreamDiffStats?: GitUpstreamDiffStats;
  worktreeOriginPath?: string;
  worktreePlaceholder?: boolean;
  worktreeSetupCommands?: string;
  interactionDisabled?: boolean;
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
