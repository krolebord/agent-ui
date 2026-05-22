import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("nano-spawn", () => ({
  default: spawnMock,
}));

import { generateCursorTitle } from "../../../../src/main/title-generation/providers/cursor";

describe("generateCursorTitle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs cursor agent with the configured model", async () => {
    spawnMock.mockResolvedValue({ output: "Refactor auth flow" });

    const result = await generateCursorTitle(
      "Fix auth + add tests",
      "composer-2-fast",
    );

    expect(result).toBe("Refactor auth flow");
    expect(spawnMock).toHaveBeenCalledWith(
      "cursor",
      [
        "agent",
        "-p",
        "--trust",
        "--model",
        "composer-2-fast",
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
      output: "\n\n  Build release plan  \nextra",
    });

    const result = await generateCursorTitle("anything", "composer-2");

    expect(result).toBe("Build release plan");
  });

  it("returns null when output is empty", async () => {
    spawnMock.mockResolvedValue({ output: "   \n" });

    const result = await generateCursorTitle("anything", "composer-2");

    expect(result).toBeNull();
  });

  it("returns null when spawn fails", async () => {
    spawnMock.mockRejectedValue(new Error("boom"));

    const result = await generateCursorTitle("anything", "composer-2");

    expect(result).toBeNull();
  });
});
