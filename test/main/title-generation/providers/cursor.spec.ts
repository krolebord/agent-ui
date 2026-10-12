import { beforeEach, describe, expect, it, vi } from "vitest";

const mkdirMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  mkdir: mkdirMock,
}));

vi.mock("nano-spawn", () => ({
  default: spawnMock,
}));

import { generateCursorTitle } from "../../../../src/main/title-generation/providers/cursor";

const workingDirectory = "/var/tmp/agent-ui-text-generation-test";

describe("generateCursorTitle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mkdirMock.mockResolvedValue(undefined);
  });

  it("runs cursor agent with the configured model", async () => {
    spawnMock.mockResolvedValue({ output: "Refactor auth flow" });

    const result = await generateCursorTitle(
      "Fix auth + add tests",
      "composer-2-fast",
      workingDirectory,
    );

    expect(result).toBe("Refactor auth flow");
    expect(spawnMock).toHaveBeenCalledWith(
      "cursor-agent",
      [
        "agent",
        "-p",
        "--trust",
        "--disable-indexing",
        "--disable-codebase-ref",
        "--model",
        "composer-2-fast",
        "--mode",
        "ask",
        expect.stringContaining("Fix auth + add tests"),
      ],
      {
        cwd: workingDirectory,
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

    const result = await generateCursorTitle(
      "anything",
      "composer-2",
      workingDirectory,
    );

    expect(result).toBe("Build release plan");
  });

  it("returns null when output is empty", async () => {
    spawnMock.mockResolvedValue({ output: "   \n" });

    const result = await generateCursorTitle(
      "anything",
      "composer-2",
      workingDirectory,
    );

    expect(result).toBeNull();
  });

  it("returns null when spawn fails", async () => {
    spawnMock.mockRejectedValue(new Error("boom"));

    const result = await generateCursorTitle(
      "anything",
      "composer-2",
      workingDirectory,
    );

    expect(result).toBeNull();
  });
});
