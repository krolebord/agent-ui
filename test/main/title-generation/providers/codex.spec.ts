import { beforeEach, describe, expect, it, vi } from "vitest";

const completeMock = vi.hoisted(() => vi.fn());
const createCodexProviderMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../src/main/llm-providers/codex", () => ({
  createCodexProvider: (model: string, options: unknown) => {
    createCodexProviderMock(model, options);
    return { complete: completeMock };
  },
}));

import { generateCodexTitle } from "../../../../src/main/title-generation/providers/codex";

describe("generateCodexTitle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses low reasoning and sanitizes the generated title", async () => {
    completeMock.mockResolvedValue("  Refactor auth flow  \nextra");

    const result = await generateCodexTitle(
      "Fix auth + add tests",
      "gpt-5.6-luna",
      "/var/tmp/agent-ui-text-generation-test",
    );

    expect(result).toBe("Refactor auth flow");
    expect(createCodexProviderMock).toHaveBeenCalledWith("gpt-5.6-luna", {
      workingDirectory: "/var/tmp/agent-ui-text-generation-test",
      reasoningEffort: "low",
    });
    expect(completeMock.mock.calls[0]?.[0]).toContain("Fix auth + add tests");
  });

  it("returns null for an empty provider result", async () => {
    completeMock.mockResolvedValue(null);

    await expect(
      generateCodexTitle(
        "anything",
        "gpt-5.6-luna",
        "/var/tmp/agent-ui-text-generation-test",
      ),
    ).resolves.toBeNull();
  });
});
