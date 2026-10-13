import { describe, expect, it } from "vitest";
import {
  codexParentThreadId,
  codexSessionId,
  isCodexSubagentSessionMeta,
  isForkedSessionMeta,
} from "../../../src/main/agent-transcripts/codex-session-meta";

const spawned = {
  id: "child",
  forked_from_id: "parent",
  source: {
    subagent: { thread_spawn: { parent_thread_id: "spawner", depth: 1 } },
  },
};
const review = {
  id: "review",
  session_id: "parent",
  parent_thread_id: "parent",
  source: { subagent: "review" },
};

describe("Codex session_meta helpers", () => {
  it("prefers the thread id over the session id", () => {
    expect(codexSessionId(review)).toBe("review");
    expect(codexSessionId({ session_id: "legacy" })).toBe("legacy");
    expect(codexSessionId({})).toBeNull();
  });

  it("treats forks and spawned subagents as copies of their parent", () => {
    expect(isForkedSessionMeta(spawned)).toBe(true);
    expect(isForkedSessionMeta({ forked_from_id: "parent" })).toBe(true);
    expect(isForkedSessionMeta(review)).toBe(false);
  });

  it("finds the parent thread for spawned, forked, and review threads", () => {
    expect(codexParentThreadId(spawned)).toBe("spawner");
    expect(codexParentThreadId({ forked_from_id: "parent" })).toBe("parent");
    expect(codexParentThreadId(review)).toBe("parent");
    expect(codexParentThreadId({ source: "vscode" })).toBeNull();
  });

  it("recognizes subagent sources", () => {
    expect(isCodexSubagentSessionMeta(spawned)).toBe(true);
    expect(isCodexSubagentSessionMeta(review)).toBe(true);
    expect(isCodexSubagentSessionMeta({ source: "vscode" })).toBe(false);
  });
});
