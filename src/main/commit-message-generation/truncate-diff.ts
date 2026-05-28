import { commitMessageDiffMaxLength } from "@shared/commit-message-generation";

export function truncateDiffForCommitMessage(diff: string): string {
  if (diff.length <= commitMessageDiffMaxLength) {
    return diff;
  }

  return `${diff.slice(0, commitMessageDiffMaxLength)}\n\n... (diff truncated)`;
}
