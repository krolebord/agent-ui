import { beforeEach, describe, expect, it, vi } from "vitest";

const completeMock = vi.hoisted(() =>
  vi.fn<(prompt: string) => Promise<string | null>>(),
);
const createLlmProviderMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/main/llm-providers", () => ({
  createLlmProvider: (settings: unknown, options: unknown) => {
    createLlmProviderMock(settings, options);
    return {
      complete: (prompt: string) => completeMock(prompt),
    };
  },
}));

import { generateCommitMessage } from "../../../src/main/commit-message-generation";

describe("generateCommitMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns parsed commit message from provider output", async () => {
    completeMock.mockResolvedValue(`SUBJECT: Add tests
BODY:
Cover commit message parsing.`);

    const result = await generateCommitMessage(
      { provider: "codex", model: "gpt-5.6-luna" },
      "diff --git a/foo.ts b/foo.ts",
      { workingDirectory: "/var/tmp/agent-ui-text-generation-test" },
    );

    expect(result).toEqual({
      subject: "Add tests",
      description: "Cover commit message parsing.",
    });
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(createLlmProviderMock).toHaveBeenCalledWith(
      { provider: "codex", model: "gpt-5.6-luna" },
      {
        timeoutMs: 60_000,
        workingDirectory: "/var/tmp/agent-ui-text-generation-test",
        reasoningEffort: "medium",
      },
    );
    expect(completeMock.mock.calls[0]?.[0]).toContain(
      "diff --git a/foo.ts b/foo.ts",
    );
  });

  it("truncates large diffs before sending to the provider", async () => {
    completeMock.mockResolvedValue("SUBJECT: Large change\nBODY:");

    await generateCommitMessage(
      { provider: "codex", model: "gpt-5.6-luna" },
      `diff --git a/foo.ts b/foo.ts\n${"x".repeat(20_000)}`,
      { workingDirectory: "/var/tmp/agent-ui-text-generation-test" },
    );

    const prompt = completeMock.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("... (diff truncated)");
    expect(prompt.length).toBeLessThan(20_000);
  });

  it("returns null for empty diff", async () => {
    const result = await generateCommitMessage(
      { provider: "codex", model: "gpt-5.6-luna" },
      "   ",
      { workingDirectory: "/var/tmp/agent-ui-text-generation-test" },
    );

    expect(result).toBeNull();
    expect(completeMock).not.toHaveBeenCalled();
  });
});
