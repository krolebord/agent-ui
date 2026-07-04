import { describe, expect, it } from "vitest";
import {
  type BuildClaudeArgsInput,
  buildClaudeArgs,
} from "../../src/main/claude-cli";

function makeInput(
  overrides: Partial<BuildClaudeArgsInput> = {},
): BuildClaudeArgsInput {
  return {
    permissionMode: "default",
    pluginDir: null,
    model: "opus",
    stateFilePath: "/tmp/state.ndjson",
    start: { type: "start-new", sessionId: "session-1" },
    ...overrides,
  };
}

describe("buildClaudeArgs", () => {
  it("omits --remote-control by default", () => {
    const { args } = buildClaudeArgs(makeInput());

    expect(args).not.toContain("--remote-control");
  });

  it("adds --remote-control when remote control is enabled", () => {
    const { args } = buildClaudeArgs(makeInput({ remoteControl: true }));

    expect(args).toContain("--remote-control");
  });

  it("adds --remote-control when resuming with remote control", () => {
    const { args } = buildClaudeArgs(
      makeInput({
        remoteControl: true,
        start: { type: "resume", sessionId: "session-1" },
      }),
    );

    expect(args).toContain("--remote-control");
    expect(args).toContain("--resume");
  });
});
