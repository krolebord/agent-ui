import { describe, expect, it } from "vitest";
import { buildCursorAgentArgs } from "../../src/main/cursor-cli";

describe("buildCursorAgentArgs", () => {
  it("quotes the MCP plugin path before prompt arguments", () => {
    const { args } = buildCursorAgentArgs({
      cwd: "/var/tmp/project",
      permissionMode: "default",
      pluginDir: "/var/tmp/Agent UI's plugin",
      initialPrompt: "- use Agent UI tools",
    });

    expect(args).toEqual([
      "agent",
      "--workspace",
      "/var/tmp/project",
      "--plugin-dir",
      "'/var/tmp/Agent UI'\"'\"'s plugin'",
      "--",
      "'- use Agent UI tools'",
    ]);
  });

  it("passes regular initial prompts as the final argument", () => {
    const { args } = buildCursorAgentArgs({
      cwd: "/tmp/project",
      permissionMode: "default",
      initialPrompt: "Summarize the repo",
    });

    expect(args).toEqual([
      "agent",
      "--workspace",
      "/tmp/project",
      "'Summarize the repo'",
    ]);
  });

  it("separates leading-hyphen prompts from Cursor options", () => {
    const { args } = buildCursorAgentArgs({
      cwd: "/tmp/project",
      permissionMode: "default",
      initialPrompt: "- explain this failure",
    });

    expect(args).toEqual([
      "agent",
      "--workspace",
      "/tmp/project",
      "--",
      "'- explain this failure'",
    ]);
  });

  it("keeps plan mode before the option terminator", () => {
    const { args } = buildCursorAgentArgs({
      cwd: "/tmp/project",
      permissionMode: "default",
      initialPrompt: "- draft a migration plan",
      plan: true,
    });

    expect(args).toEqual([
      "agent",
      "--workspace",
      "/tmp/project",
      "--plan",
      "--",
      "'- draft a migration plan'",
    ]);
  });
});
