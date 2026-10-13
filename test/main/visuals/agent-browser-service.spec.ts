import { describe, expect, it, vi } from "vitest";
import type { AgentBrowserStatus } from "../../../src/main/visuals/agent-browser";
import {
  AgentBrowserService,
  defineAgentBrowserState,
} from "../../../src/main/visuals/agent-browser-service";

function createService(detect: () => Promise<AgentBrowserStatus>) {
  return new AgentBrowserService(defineAgentBrowserState(), detect);
}

describe("AgentBrowserService", () => {
  it("starts in the checking state", () => {
    const service = createService(async () => ({
      available: true,
      version: "0.37.1",
    }));

    expect(service.state.state).toEqual({ status: "checking" });
    expect(service.isUnavailable).toBe(false);
  });

  it("records an available agent-browser", async () => {
    const service = createService(async () => ({
      available: true,
      version: "0.37.1",
    }));

    await service.refresh();

    expect(service.state.state).toMatchObject({
      status: "available",
      version: "0.37.1",
    });
    expect(service.isUnavailable).toBe(false);
  });

  it("records why agent-browser is unavailable", async () => {
    const service = createService(async () => ({
      available: false,
      error: "agent-browser is not installed or not on PATH",
    }));

    await service.refresh();

    expect(service.state.state).toMatchObject({
      status: "unavailable",
      error: "agent-browser is not installed or not on PATH",
    });
    expect(service.isUnavailable).toBe(true);
  });

  it("treats a failing detection as unavailable", async () => {
    const service = createService(async () => {
      throw new Error("spawn failed");
    });

    await expect(service.refresh()).resolves.toMatchObject({
      status: "unavailable",
      error: "spawn failed",
    });
    expect(service.isUnavailable).toBe(true);
  });

  it("shares one detection between concurrent refreshes", async () => {
    const detect = vi.fn(
      async (): Promise<AgentBrowserStatus> => ({
        available: true,
        version: "0.37.1",
      }),
    );
    const service = createService(detect);

    await Promise.all([service.refresh(), service.refresh()]);
    expect(detect).toHaveBeenCalledTimes(1);

    await service.refresh();
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it("goes back to unavailable when agent-browser disappears", async () => {
    const detect = vi
      .fn<() => Promise<AgentBrowserStatus>>()
      .mockResolvedValueOnce({ available: true, version: "0.37.1" })
      .mockResolvedValueOnce({ available: false, error: "gone" });
    const service = createService(detect);

    await service.refresh();
    await service.refresh();

    expect(service.state.state).toMatchObject({
      status: "unavailable",
      error: "gone",
    });
  });
});
