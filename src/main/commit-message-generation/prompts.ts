export const commitMessageSystemPrompt = `You are a git commit message assistant.

Given a git diff, write a commit message with:
- A subject line (imperative mood, max 72 chars, no period)
- An optional body with more detail (wrap at 72 chars)

Output format:
SUBJECT: <subject line>
BODY:
<optional body, or leave empty>

**CRITICAL:** output only in that format, nothing else.`;

export function generateCommitMessagePrompt(diff: string): string {
  return `${commitMessageSystemPrompt}

Git diff:
\`\`\`diff
${diff}
\`\`\`

Commit message:`;
}
