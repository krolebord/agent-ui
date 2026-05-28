export const commitMessageDiffMaxLength = 10_000;

export interface GeneratedCommitMessage {
  subject: string;
  description?: string;
}
