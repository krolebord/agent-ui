import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("nano-spawn", () => ({
  default: spawnMock,
}));

import { createCursorProvider } from "../../../src/main/llm-providers/cursor";

describe("createCursorProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs cursor agent with the configured model", async () => {
    spawnMock.mockResolvedValue({ output: "Generated text" });

    const provider = createCursorProvider("composer-2-fast");
    const result = await provider.complete("Summarize this prompt");

    expect(result).toBe("Generated text");
    expect(spawnMock).toHaveBeenCalledWith(
      "cursor",
      [
        "agent",
        "-p",
        "--trust",
        "--model",
        "composer-2-fast",
        "--mode",
        "ask",
        "Summarize this prompt",
      ],
      {
        preferLocal: true,
        timeout: 30_000,
        stdin: "ignore",
      },
    );
  });

  it("returns trimmed output", async () => {
    spawnMock.mockResolvedValue({ output: "\n\n  Build release plan  \n" });

    const provider = createCursorProvider("composer-2");
    const result = await provider.complete("anything");

    expect(result).toBe("Build release plan");
  });

  it("returns null when output is empty", async () => {
    spawnMock.mockResolvedValue({ output: "   \n" });

    const provider = createCursorProvider("composer-2");
    const result = await provider.complete("anything");

    expect(result).toBeNull();
  });

  it("returns null when spawn fails", async () => {
    spawnMock.mockRejectedValue(new Error("boom"));

    const provider = createCursorProvider("composer-2");
    const result = await provider.complete("anything");

    expect(result).toBeNull();
  });
});
