export const commitMessageDiffMaxLength = 10_000;

/** Placeholder subject used while autogenerating a commit message. */
export const autogenerateCommitPlaceholderSubject =
  "[agent-ui] Pending commit message";

export interface GeneratedCommitMessage {
  subject: string;
  description?: string;
}

export function formatCommittedWithPlaceholderNote(
  placeholderSubject = autogenerateCommitPlaceholderSubject,
): string {
  return `The changes were committed with the temporary message "${placeholderSubject}".`;
}

export type CommitProgressEvent =
  | { stage: "committing" }
  | { stage: "committed" }
  | { stage: "generating" }
  | { stage: "done" };
