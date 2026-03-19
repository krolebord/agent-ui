import { describe, expect, it } from "vitest";
import { buildCodexArgs } from "../../src/main/codex-cli";

describe("buildCodexArgs", () => {
  it("defaults model reasoning effort to high without fast-mode flags", () => {
    const { args } = buildCodexArgs({
      permissionMode: "default",
    });

    expect(args).toEqual([
      "--no-alt-screen",
      "--model",
      "gpt-5.3-codex",
      "-c",
      "model_reasoning_effort=high",
    ]);
  });

  it("uses provided model reasoning effort", () => {
    const { args } = buildCodexArgs({
      permissionMode: "default",
      modelReasoningEffort: "minimal",
    });

    expect(args).toContain("-c");
    expect(args).toContain("model_reasoning_effort=minimal");
  });

  it("enables fast mode with the fast service tier", () => {
    const { args } = buildCodexArgs({
      permissionMode: "default",
      fastMode: "fast",
    });

    expect(args).toContain("--enable");
    expect(args).toContain("fast_mode");
    expect(args).toContain("service_tier=fast");
  });

  it("disables fast mode when explicitly turned off", () => {
    const { args } = buildCodexArgs({
      permissionMode: "default",
      fastMode: "off",
    });

    expect(args).toContain("--disable");
    expect(args).toContain("fast_mode");
    expect(args).not.toContain("service_tier=fast");
  });

  it("builds resume args when a codex session id is provided", () => {
    const { args } = buildCodexArgs({
      permissionMode: "default",
      resumeSessionId: "019d0192-767b-7cc1-bdd9-9c8a13484557",
      initialPrompt: "should not be forwarded",
    });

    expect(args).toEqual([
      "resume",
      "019d0192-767b-7cc1-bdd9-9c8a13484557",
      "--no-alt-screen",
      "--model",
      "gpt-5.3-codex",
      "-c",
      "model_reasoning_effort=high",
    ]);
  });
});
