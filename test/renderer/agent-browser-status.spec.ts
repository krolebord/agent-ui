import { describeAgentBrowserStatus } from "@renderer/lib/agent-browser-status";
import { describe, expect, it } from "vitest";

describe("describeAgentBrowserStatus", () => {
  it("describes each state", () => {
    expect(describeAgentBrowserStatus({ status: "checking" })).toBe(
      "Checking for agent-browser…",
    );
    expect(
      describeAgentBrowserStatus({
        status: "available",
        version: "0.37.1",
        checkedAt: 1,
      }),
    ).toBe("agent-browser 0.37.1 available");
    expect(
      describeAgentBrowserStatus({
        status: "unavailable",
        error: "agent-browser is not installed or not on PATH",
        checkedAt: 1,
      }),
    ).toBe("Not available: agent-browser is not installed or not on PATH");
  });
});
