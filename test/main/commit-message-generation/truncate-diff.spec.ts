import { describe, expect, it } from "vitest";
import { truncateDiffForCommitMessage } from "../../../src/main/commit-message-generation/truncate-diff";
import { commitMessageDiffMaxLength } from "../../../src/shared/commit-message-generation";

describe("truncateDiffForCommitMessage", () => {
  it("returns diff unchanged when under the limit", () => {
    const diff = "diff --git a/foo.ts b/foo.ts\n+hello";
    expect(truncateDiffForCommitMessage(diff)).toBe(diff);
  });

  it("truncates diff at the max length", () => {
    const diff = "a".repeat(commitMessageDiffMaxLength + 50);
    const truncated = truncateDiffForCommitMessage(diff);

    expect(truncated.startsWith("a".repeat(commitMessageDiffMaxLength))).toBe(
      true,
    );
    expect(truncated.endsWith("\n\n... (diff truncated)")).toBe(true);
    expect(truncated.length).toBe(
      commitMessageDiffMaxLength + "\n\n... (diff truncated)".length,
    );
  });
});
