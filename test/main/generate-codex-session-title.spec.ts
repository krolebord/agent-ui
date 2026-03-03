import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("nano-spawn", () => ({
  default: spawnMock,
}));

import { generateCodexSessionTitle } from "../../src/main/generate-codex-session-title";

describe("generateCodexSessionTitle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs codex exec with expected flags and prompt", async () => {
    spawnMock.mockResolvedValue({ stdout: "Refactor auth flow" });

    const result = await generateCodexSessionTitle("Fix auth + add tests");

    expect(result).toBe("Refactor auth flow");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      "codex",
      [
        "exec",
        "--model",
        "gpt-5.1-codex-mini",
        "--ephemeral",
        "--color",
        "never",
        "--skip-git-repo-check",
        "-c",
        "hide_agent_reasoning=true",
        "-c",
        "model_reasoning_summary=none",
        "-c",
        "suppress_unstable_features_warning=true",
        "-c",
        "mcp_servers={}",
        expect.stringContaining("Fix auth + add tests"),
      ],
      {
        preferLocal: true,
        timeout: 30_000,
        stdin: "ignore",
      },
    );
  });

  it("returns first non-empty output line", async () => {
    spawnMock.mockResolvedValue({
      stdout: "\n\n  Build release plan  \nextra",
    });

    const result = await generateCodexSessionTitle("anything");

    expect(result).toBe("Build release plan");
  });

  it("returns fallback when output is empty", async () => {
    spawnMock.mockResolvedValue({ stdout: "   \n" });

    const result = await generateCodexSessionTitle("anything");

    expect(result).toBe("Codex Session");
  });

  it("ignores stderr-only output and returns fallback", async () => {
    spawnMock.mockResolvedValue({
      stdout: "   \n",
      stderr: "OpenAI Codex v0.104.0",
      output: "OpenAI Codex v0.104.0",
    });

    const result = await generateCodexSessionTitle("anything");

    expect(result).toBe("Codex Session");
  });

  it("returns fallback when spawn fails", async () => {
    spawnMock.mockRejectedValue(new Error("boom"));

    const result = await generateCodexSessionTitle("anything");

    expect(result).toBe("Codex Session");
  });
});
