import path from "node:path";

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
