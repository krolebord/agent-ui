import { beforeEach, describe, expect, it, vi } from "vitest";

const mkdirMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  mkdir: mkdirMock,
}));

vi.mock("nano-spawn", () => ({
  default: spawnMock,
}));

import { createCursorProvider } from "../../../src/main/llm-providers/cursor";

const workingDirectory = "/var/tmp/agent-ui-text-generation-test";

describe("createCursorProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mkdirMock.mockResolvedValue(undefined);
  });

  it("runs cursor agent with the configured model", async () => {
    spawnMock.mockResolvedValue({ output: "Generated text" });

    const provider = createCursorProvider("composer-2-fast", {
      workingDirectory,
    });
    const result = await provider.complete("Summarize this prompt");

    expect(result).toBe("Generated text");
    expect(mkdirMock).toHaveBeenCalledWith(workingDirectory, {
      recursive: true,
    });
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
        "Summarize this prompt",
      ],
      {
        cwd: workingDirectory,
        preferLocal: true,
        timeout: 30_000,
        stdin: "ignore",
      },
    );
  });

  it("returns trimmed output", async () => {
    spawnMock.mockResolvedValue({ output: "\n\n  Build release plan  \n" });

    const provider = createCursorProvider("composer-2", { workingDirectory });
    const result = await provider.complete("anything");

    expect(result).toBe("Build release plan");
  });

  it("returns null when output is empty", async () => {
    spawnMock.mockResolvedValue({ output: "   \n" });

    const provider = createCursorProvider("composer-2", { workingDirectory });
    const result = await provider.complete("anything");

    expect(result).toBeNull();
  });

  it("returns null when spawn fails", async () => {
    spawnMock.mockRejectedValue(new Error("boom"));

    const provider = createCursorProvider("composer-2", { workingDirectory });
    const result = await provider.complete("anything");

    expect(result).toBeNull();
  });
});
