import { beforeEach, describe, expect, it, vi } from "vitest";

const mkdirMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  mkdir: mkdirMock,
}));

vi.mock("nano-spawn", () => ({
  default: spawnMock,
}));

import {
  createCodexProvider,
  parseCodexTextGenerationOutput,
} from "../../../src/main/llm-providers/codex";

const workingDirectory = "/var/tmp/agent-ui-text-generation-test";

describe("createCodexProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mkdirMock.mockResolvedValue(undefined);
  });

  it("runs Luna on the standard tier without user tools or project context", async () => {
    spawnMock.mockResolvedValue({
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item-1",
            type: "agent_message",
            text: "Generated text",
          },
        }),
      ].join("\n"),
    });

    const provider = createCodexProvider("gpt-5.6-luna", {
      workingDirectory,
      reasoningEffort: "low",
    });
    const result = await provider.complete("Summarize this prompt");

    expect(result).toBe("Generated text");
    expect(mkdirMock).toHaveBeenCalledWith(workingDirectory, {
      recursive: true,
    });
    expect(spawnMock).toHaveBeenCalledWith(
      "codex",
      [
        "-a",
        "never",
        "--disable",
        "plugins",
        "--disable",
        "remote_plugin",
        "--disable",
        "apps",
        "--disable",
        "multi_agent",
        "exec",
        "--strict-config",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "-C",
        workingDirectory,
        "-s",
        "read-only",
        "-m",
        "gpt-5.6-luna",
        "-c",
        'model_reasoning_effort="low"',
        "-c",
        'model_verbosity="low"',
        "-c",
        'service_tier="default"',
        "--json",
        "-",
      ],
      {
        cwd: workingDirectory,
        preferLocal: true,
        timeout: 30_000,
        stdin: { string: "Summarize this prompt" },
      },
    );
  });

  it("uses the configured timeout and returns null when Codex fails", async () => {
    spawnMock.mockRejectedValue(new Error("boom"));

    const provider = createCodexProvider("gpt-5.6-luna", {
      workingDirectory,
      reasoningEffort: "medium",
      timeoutMs: 60_000,
    });

    await expect(provider.complete("anything")).resolves.toBeNull();
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ timeout: 60_000 });
  });
});

describe("parseCodexTextGenerationOutput", () => {
  it("returns the last completed agent message", () => {
    const output = [
      "not json",
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: " First draft " },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: " Final answer " },
      }),
    ].join("\n");

    expect(parseCodexTextGenerationOutput(output)).toBe("Final answer");
  });

  it("returns null without an agent message", () => {
    expect(
      parseCodexTextGenerationOutput(
        JSON.stringify({ type: "turn.completed", usage: {} }),
      ),
    ).toBeNull();
  });
});
