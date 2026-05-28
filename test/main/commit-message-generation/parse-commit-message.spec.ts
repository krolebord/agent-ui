import { describe, expect, it } from "vitest";
import { parseGeneratedCommitMessage } from "../../../src/main/commit-message-generation/parse-commit-message";

describe("parseGeneratedCommitMessage", () => {
  it("parses subject and body", () => {
    expect(
      parseGeneratedCommitMessage(`SUBJECT: Add commit autogeneration
BODY:
Generate commit messages from selected diff using the Cursor provider.`),
    ).toEqual({
      subject: "Add commit autogeneration",
      description:
        "Generate commit messages from selected diff using the Cursor provider.",
    });
  });

  it("parses subject-only output", () => {
    expect(
      parseGeneratedCommitMessage(`SUBJECT: Fix auth flow
BODY:`),
    ).toEqual({
      subject: "Fix auth flow",
    });
  });

  it("returns null when subject is missing", () => {
    expect(parseGeneratedCommitMessage("BODY:\nSome text")).toBeNull();
  });

  it("returns null when subject is empty", () => {
    expect(parseGeneratedCommitMessage("SUBJECT:\nBODY:\n")).toBeNull();
  });
});
