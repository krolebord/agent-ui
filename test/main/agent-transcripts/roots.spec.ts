import { describe, expect, it } from "vitest";
import { resolveTranscriptRoots } from "../../../src/main/agent-transcripts/roots";

describe("resolveTranscriptRoots", () => {
  it("defaults to the agents' home directories", () => {
    expect(resolveTranscriptRoots({ env: {}, homeDir: "/home/me" })).toEqual({
      claudeProjects: "/home/me/.claude/projects",
      codexSessions: "/home/me/.codex/sessions",
      cursorProjects: "/home/me/.cursor/projects",
      cursorChats: "/home/me/.cursor/chats",
    });
  });

  it("honors CLAUDE_CONFIG_DIR and CODEX_HOME", () => {
    expect(
      resolveTranscriptRoots({
        env: { CLAUDE_CONFIG_DIR: " /cfg/claude ", CODEX_HOME: "/cfg/codex" },
        homeDir: "/home/me",
      }),
    ).toMatchObject({
      claudeProjects: "/cfg/claude/projects",
      codexSessions: "/cfg/codex/sessions",
    });
  });
});
