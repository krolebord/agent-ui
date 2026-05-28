import type { GeneratedCommitMessage } from "@shared/commit-message-generation";

export function parseGeneratedCommitMessage(
  raw: string,
): GeneratedCommitMessage | null {
  const subjectLineIndex = raw
    .split(/\r?\n/)
    .findIndex((line) => /^SUBJECT:/i.test(line.trimStart()));
  if (subjectLineIndex < 0) {
    return null;
  }

  const lines = raw.split(/\r?\n/);
  const subjectLine = lines[subjectLineIndex] ?? "";
  const subject = subjectLine.replace(/^SUBJECT:[ \t]*/i, "").trim();
  if (!subject) {
    return null;
  }

  const bodyStartIndex = lines.findIndex((line) =>
    /^BODY:/i.test(line.trimStart()),
  );
  if (bodyStartIndex < 0) {
    return { subject };
  }

  const bodyFirstLine = lines[bodyStartIndex] ?? "";
  const inlineBody = bodyFirstLine.replace(/^BODY:[ \t]*/i, "").trim();
  const followingLines = lines
    .slice(bodyStartIndex + 1)
    .join("\n")
    .trim();
  const description = [inlineBody, followingLines]
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!description) {
    return { subject };
  }

  return { subject, description };
}
