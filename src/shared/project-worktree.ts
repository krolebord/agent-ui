import { randomUUID } from "node:crypto";
import path from "node:path";

export const WORKTREE_BRANCH_PREFIX = "agent-ui/";

const WORKTREE_BRANCH_SEGMENT_MAX_LENGTH = 40;

export function sanitizeWorktreeBranchSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, WORKTREE_BRANCH_SEGMENT_MAX_LENGTH)
    .replace(/[-._]+$/g, "");
}

export function generatePlaceholderWorktreeSegment(): string {
  return randomUUID().slice(0, 8);
}

export function buildWorktreeBranchName(segment: string): string {
  return `${WORKTREE_BRANCH_PREFIX}${segment}`;
}

export function sanitizeWorktreePathSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .replace(/^-+|-+$/g, "");

  return sanitized || "worktree";
}

export function buildSuggestedWorktreePath(
  sourcePath: string,
  branchName: string,
): string {
  const repoName = path.basename(sourcePath);
  const branchSegment = sanitizeWorktreePathSegment(branchName);
  return path.join(path.dirname(sourcePath), `${repoName}-${branchSegment}`);
}
