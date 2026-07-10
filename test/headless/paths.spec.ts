import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHeadlessPaths } from "../../src/headless/paths";

describe("resolveHeadlessPaths", () => {
  it("uses the existing macOS application directories", () => {
    expect(
      resolveHeadlessPaths({
        platform: "darwin",
        env: {},
        homeDir: "/Users/tester",
      }),
    ).toEqual({
      userData: "/Users/tester/Library/Application Support/agent-ui",
      logs: "/Users/tester/Library/Logs/agent-ui",
    });
  });

  it("uses XDG directories on Linux", () => {
    expect(
      resolveHeadlessPaths({
        platform: "linux",
        env: {
          XDG_CONFIG_HOME: "/srv/config",
          XDG_STATE_HOME: "/srv/state",
        },
        homeDir: "/home/tester",
      }),
    ).toEqual({
      userData: "/srv/config/agent-ui",
      logs: "/srv/state/agent-ui/logs",
    });
  });

  it("falls back to home-relative XDG directories", () => {
    expect(
      resolveHeadlessPaths({
        platform: "linux",
        env: {},
        homeDir: "/home/tester",
      }),
    ).toEqual({
      userData: "/home/tester/.config/agent-ui",
      logs: "/home/tester/.local/state/agent-ui/logs",
    });
  });

  it("ignores relative XDG directory values", () => {
    expect(
      resolveHeadlessPaths({
        platform: "linux",
        env: {
          XDG_CONFIG_HOME: "config",
          XDG_STATE_HOME: "state",
        },
        homeDir: "/home/tester",
      }),
    ).toEqual({
      userData: "/home/tester/.config/agent-ui",
      logs: "/home/tester/.local/state/agent-ui/logs",
    });
  });

  it("lets AGENT_UI_DATA_DIR override platform defaults", () => {
    expect(
      resolveHeadlessPaths({
        platform: "linux",
        env: { AGENT_UI_DATA_DIR: "./agent-data" },
        homeDir: "/home/tester",
        cwd: "/srv/agent-ui",
      }),
    ).toEqual({
      userData: path.join("/srv/agent-ui", "agent-data"),
      logs: path.join("/srv/agent-ui", "agent-data", "logs"),
    });
  });
});
