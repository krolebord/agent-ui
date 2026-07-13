import { beforeEach, describe, expect, it, vi } from "vitest";

const appServerStartMock = vi.hoisted(() => vi.fn());
const appServerStopMock = vi.hoisted(() => vi.fn());
const trackerStartMock = vi.hoisted(() => vi.fn());
const trackerStopMock = vi.hoisted(() => vi.fn());
const readAccountRateLimitsMock = vi.hoisted(() => vi.fn());
const appServerConstructorMock = vi.hoisted(() => vi.fn());
const trackerConstructorMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/main/codex-app-server-runtime", () => {
  class CodexAppServerProcessMock {
    readonly wsUrl = "ws://127.0.0.1:34567";
    readonly start = appServerStartMock;
    readonly stop = appServerStopMock;

    constructor(options: unknown) {
      appServerConstructorMock(options);
    }
  }

  return { CodexAppServerProcess: CodexAppServerProcessMock };
});

vi.mock("../../src/main/codex-app-server-tracker", () => {
  class CodexAppServerTrackerMock {
    readonly start = trackerStartMock;
    readonly stop = trackerStopMock;
    readonly readAccountRateLimits = readAccountRateLimitsMock;

    constructor(options: unknown) {
      trackerConstructorMock(options);
    }
  }

  return { CodexAppServerTracker: CodexAppServerTrackerMock };
});

vi.mock("../../src/main/logger", () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { getCodexUsage } from "../../src/main/codex-usage";

function buildRateLimitsResponse() {
  return {
    rateLimits: {
      limitId: "codex",
      limitName: null,
      primary: {
        usedPercent: 8,
        windowDurationMins: 300,
        resetsAt: 1_783_705_404,
      },
      secondary: {
        usedPercent: 17,
        windowDurationMins: 10_080,
        resetsAt: 1_784_272_276,
      },
      credits: {
        hasCredits: true,
        unlimited: false,
        balance: "5.39",
      },
      planType: "team",
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: {},
    rateLimitResetCredits: null,
  };
}

describe("getCodexUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appServerStartMock.mockResolvedValue(undefined);
    appServerStopMock.mockResolvedValue(undefined);
    trackerStartMock.mockResolvedValue(undefined);
    trackerStopMock.mockResolvedValue(undefined);
    readAccountRateLimitsMock.mockResolvedValue(buildRateLimitsResponse());
  });

  it("reads and normalizes rate limits through Codex app-server", async () => {
    const result = await getCodexUsage();

    expect(appServerConstructorMock).toHaveBeenCalledWith({
      sessionId: "usage",
    });
    expect(trackerConstructorMock).toHaveBeenCalledWith({
      sessionId: "usage",
      wsUrl: "ws://127.0.0.1:34567",
    });
    expect(readAccountRateLimitsMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      usage: {
        planType: "team",
        primaryWindow: {
          utilization: 8,
          windowSeconds: 18_000,
          resetsAt: "2026-07-10T17:43:24.000Z",
        },
        secondaryWindow: {
          utilization: 17,
          windowSeconds: 604_800,
        },
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: 5.39,
        },
      },
    });
    expect(trackerStopMock).toHaveBeenCalledOnce();
    expect(appServerStopMock).toHaveBeenCalledOnce();
  });

  it("uses the codex multi-bucket snapshot when the compatibility view is null", async () => {
    readAccountRateLimitsMock.mockResolvedValue({
      rateLimits: null,
      rateLimitsByLimitId: {
        another_limit: {
          limitId: "another_limit",
          primary: {
            usedPercent: 90,
            windowDurationMins: 60,
            resetsAt: 1_783_705_404,
          },
          secondary: null,
        },
        codex: {
          limitId: "codex",
          primary: {
            usedPercent: 12,
            windowDurationMins: 300,
            resetsAt: 1_783_705_404,
          },
          secondary: null,
          planType: "plus",
        },
      },
    });

    const result = await getCodexUsage();

    expect(result).toMatchObject({
      ok: true,
      usage: {
        planType: "plus",
        primaryWindow: { utilization: 12 },
        secondaryWindow: null,
      },
    });
  });

  it("merges the weekly window from a separate bucket when limits are split", async () => {
    readAccountRateLimitsMock.mockResolvedValue({
      rateLimits: null,
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: {
            usedPercent: 12,
            windowDurationMins: 300,
            resetsAt: 1_783_705_404,
          },
          secondary: null,
          planType: "plus",
        },
        codex_weekly: {
          limitId: "codex_weekly",
          primary: {
            usedPercent: 43,
            windowDurationMins: 10_080,
            resetsAt: 1_784_272_276,
          },
          secondary: null,
          credits: {
            hasCredits: true,
            unlimited: false,
            balance: "2.50",
          },
        },
      },
    });

    const result = await getCodexUsage();

    expect(result).toMatchObject({
      ok: true,
      usage: {
        planType: "plus",
        primaryWindow: {
          utilization: 12,
          windowSeconds: 18_000,
        },
        secondaryWindow: {
          utilization: 43,
          windowSeconds: 604_800,
          resetsAt: "2026-07-17T07:11:16.000Z",
        },
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: 2.5,
        },
      },
    });
  });

  it("reports unsupported login methods when no rate-limit snapshot exists", async () => {
    readAccountRateLimitsMock.mockResolvedValue({
      rateLimits: null,
      rateLimitsByLimitId: {},
    });

    const result = await getCodexUsage();

    expect(result).toEqual({
      ok: false,
      message: "Codex plan usage is unavailable for this login method",
    });
  });

  it("stops the app-server when the request fails", async () => {
    readAccountRateLimitsMock.mockRejectedValue(new Error("not authenticated"));

    const result = await getCodexUsage();

    expect(result).toEqual({
      ok: false,
      message: "Failed to fetch Codex usage data",
    });
    expect(trackerStopMock).toHaveBeenCalledOnce();
    expect(appServerStopMock).toHaveBeenCalledOnce();
  });

  it("rejects unexpected app-server responses", async () => {
    readAccountRateLimitsMock.mockResolvedValue({ rateLimits: {} });

    const result = await getCodexUsage();

    expect(result).toEqual({
      ok: false,
      message: "Codex usage response has unexpected format",
    });
  });
});
