import { describe, expect, it } from "vitest";
import {
  countAttentionSessions,
  sessionNeedsAttention,
} from "../../src/shared/session-attention";

describe("session attention", () => {
  it("matches the statuses that need user input or approval", () => {
    expect(sessionNeedsAttention("awaiting_user_response")).toBe(true);
    expect(sessionNeedsAttention("awaiting_approval")).toBe(true);
    expect(sessionNeedsAttention("running")).toBe(false);
    expect(sessionNeedsAttention("stopped")).toBe(false);
  });

  it("counts attention sessions", () => {
    expect(
      countAttentionSessions([
        { status: "running" },
        { status: "awaiting_user_response" },
        { status: "awaiting_approval" },
        { status: "stopped" },
      ]),
    ).toBe(2);
  });
});
