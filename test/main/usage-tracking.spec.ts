import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const claudeUsageMocks = vi.hoisted(() => ({
  getUsage: vi.fn(),
  fetchUsageWithToken: vi.fn(),
}));
const codexUsageMocks = vi.hoisted(() => ({
  getCodexUsage: vi.fn(),
}));
const cursorUsageMocks = vi.hoisted(() => ({
  getCursorUsage: vi.fn(),
}));

vi.mock("../../src/main/claude-usage", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/main/claude-usage")
  >("../../src/main/claude-usage");
  return { ...actual, ...claudeUsageMocks };
});
vi.mock("../../src/main/codex-usage", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/main/codex-usage")
  >("../../src/main/codex-usage");
  return { ...actual, ...codexUsageMocks };
});
vi.mock("../../src/main/cursor-usage", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/main/cursor-usage")
  >("../../src/main/cursor-usage");
  return { ...actual, ...cursorUsageMocks };
});
vi.mock("../../src/main/logger", () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  type ClaudeAccountRecord,
  defineClaudeAccountsPublicState,
  type PublicClaudeAccount,
} from "../../src/main/claude-accounts";
import {
  defineCodexAccountsPublicState,
  type PublicCodexAccount,
} from "../../src/main/codex-accounts";
import {
  defineUsagePersistence,
  defineUsageState,
  UsageTracker,
  type UsageTrackerOptions,
} from "../../src/main/usage-tracking";

const CLAUDE_USAGE = {
  five_hour: { utilization: 12, resets_at: null },
  seven_day: null,
  seven_day_sonnet: null,
  extra_usage: null,
};

const CODEX_USAGE = {
  planType: "plus",
  primaryWindow: { utilization: 30, resetsAt: null, windowSeconds: 18_000 },
  secondaryWindow: null,
};

const CURSOR_USAGE = {
  billingCycleStart: null,
  billingCycleEnd: "2026-10-01T00:00:00.000Z",
  membershipType: "pro",
  planUsage: {
    includedSpend: 0,
    limit: null,
    totalPercentUsed: 4,
    autoPercentUsed: null,
    apiPercentUsed: null,
    totalSpend: null,
    bonusSpend: null,
  },
  spendLimitUsage: null,
  credits: null,
};

function managedClaudeAccount(id: string): PublicClaudeAccount {
  return {
    id,
    type: "managed",
    label: `Claude ${id}`,
    createdAt: 0,
    status: "ok",
  };
}

function managedCodexAccount(id: string): PublicCodexAccount {
  return {
    id,
    type: "managed",
    label: `Codex ${id}`,
    createdAt: 0,
    status: "ok",
  };
}

function createTracker(overrides: Partial<UsageTrackerOptions> = {}) {
  const state = defineUsageState();
  const claudePublicState = defineClaudeAccountsPublicState();
  const codexPublicState = defineCodexAccountsPublicState();

  // Mirrors the internal record the service would hold for each public one.
  const getAccount = (id: string): ClaudeAccountRecord | null => {
    const account = claudePublicState.state.accounts.find(
      (entry) => entry.id === id,
    );
    if (!account) {
      return null;
    }
    if (account.type === "setup-token") {
      return {
        id,
        type: "setup-token",
        label: account.label,
        token: "setup-token-value",
        createdAt: 0,
      };
    }
    return {
      id,
      type: "managed",
      label: account.label,
      createdAt: 0,
      status: account.status,
      oauth: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: Number.MAX_SAFE_INTEGER,
        scopes: [],
      },
    };
  };

  const claudeAccounts = {
    publicState: claudePublicState,
    getAccount: vi.fn(getAccount),
    getValidAccessToken: vi.fn(async () => "access-token"),
  };
  const codexAccounts = {
    publicState: codexPublicState,
    getExternalAuth: vi.fn(async (accountId: string) => ({
      accessToken: `token-${accountId}`,
      chatgptAccountId: `workspace-${accountId}`,
    })),
  };

  const tracker = new UsageTracker({
    state,
    claudeAccounts,
    codexAccounts,
    ...overrides,
  });

  return {
    tracker,
    state,
    claudePublicState,
    codexPublicState,
    claudeAccounts,
    codexAccounts,
    entries: () => state.state.entries,
  };
}

describe("UsageTracker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claudeUsageMocks.getUsage.mockResolvedValue({
      ok: true,
      usage: CLAUDE_USAGE,
    });
    claudeUsageMocks.fetchUsageWithToken.mockResolvedValue({
      ok: true,
      usage: CLAUDE_USAGE,
    });
    codexUsageMocks.getCodexUsage.mockResolvedValue({
      ok: true,
      usage: CODEX_USAGE,
    });
    cursorUsageMocks.getCursorUsage.mockResolvedValue({
      ok: true,
      usage: CURSOR_USAGE,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks every CLI login and managed account", async () => {
    const harness = createTracker();
    harness.claudePublicState.updateState((draft) => {
      draft.accounts = [managedClaudeAccount("claude-1")];
    });
    harness.codexPublicState.updateState((draft) => {
      draft.accounts = [managedCodexAccount("codex-1")];
    });

    harness.tracker.start();
    await vi.waitFor(() => {
      expect(Object.keys(harness.entries()).sort()).toEqual([
        "claude:claude-1",
        "claude:default",
        "codex:codex-1",
        "codex:default",
        "cursor:default",
      ]);
    });

    await vi.waitFor(() => {
      for (const entry of Object.values(harness.entries())) {
        expect(entry.status).toBe("ok");
        expect(entry.refreshing).toBe(false);
        expect(entry.data).not.toBeNull();
        expect(entry.fetchedAt).toBeTypeOf("number");
      }
    });

    expect(claudeUsageMocks.getUsage).toHaveBeenCalledOnce();
    expect(claudeUsageMocks.fetchUsageWithToken).toHaveBeenCalledWith(
      "access-token",
    );
    expect(cursorUsageMocks.getCursorUsage).toHaveBeenCalledOnce();
    harness.tracker.dispose();
  });

  it("re-reads every tracked entry on refreshAll", async () => {
    const harness = createTracker();
    harness.claudePublicState.updateState((draft) => {
      draft.accounts = [managedClaudeAccount("claude-1")];
    });

    harness.tracker.start();
    await vi.waitFor(() => {
      const entries = Object.values(harness.entries());
      expect(entries).toHaveLength(4);
      for (const entry of entries) {
        expect(entry.status).toBe("ok");
        expect(entry.refreshing).toBe(false);
      }
    });
    vi.clearAllMocks();

    await harness.tracker.refreshAll();

    expect(claudeUsageMocks.getUsage).toHaveBeenCalledOnce();
    expect(claudeUsageMocks.fetchUsageWithToken).toHaveBeenCalledOnce();
    expect(codexUsageMocks.getCodexUsage).toHaveBeenCalledOnce();
    expect(cursorUsageMocks.getCursorUsage).toHaveBeenCalledOnce();
    harness.tracker.dispose();
  });

  it("marks accounts that cannot report usage unsupported without fetching", async () => {
    const harness = createTracker();
    harness.claudePublicState.updateState((draft) => {
      draft.accounts = [
        {
          id: "setup-1",
          type: "setup-token",
          label: "Setup token",
          createdAt: 0,
          status: "ok",
        },
        { ...managedClaudeAccount("dead-1"), status: "needs-relogin" },
      ];
    });

    harness.tracker.start();
    await vi.waitFor(() => {
      expect(harness.entries()["claude:setup-1"]?.status).toBe("unsupported");
      expect(harness.entries()["claude:dead-1"]?.status).toBe("unsupported");
    });

    expect(harness.entries()["claude:setup-1"]?.error).toMatch("setup-token");
    expect(harness.entries()["claude:dead-1"]?.error).toMatch("logged in");
    expect(claudeUsageMocks.fetchUsageWithToken).not.toHaveBeenCalled();

    const result = await harness.tracker.refresh("claude:setup-1");
    expect(result.ok).toBe(false);
    expect(claudeUsageMocks.fetchUsageWithToken).not.toHaveBeenCalled();
    harness.tracker.dispose();
  });

  it("keeps the last reading when a refresh fails", async () => {
    const harness = createTracker();
    harness.tracker.start();
    await vi.waitFor(() => {
      expect(harness.entries()["cursor:default"]?.status).toBe("ok");
    });
    const fetchedAt = harness.entries()["cursor:default"]?.fetchedAt;

    cursorUsageMocks.getCursorUsage.mockResolvedValue({
      ok: false,
      message: "Failed to read Cursor access token",
    });
    const result = await harness.tracker.refresh("cursor:default");

    expect(result).toEqual({
      ok: false,
      message: "Failed to read Cursor access token",
    });
    const entry = harness.entries()["cursor:default"];
    expect(entry?.status).toBe("error");
    expect(entry?.error).toBe("Failed to read Cursor access token");
    expect(entry?.data).toEqual(CURSOR_USAGE);
    expect(entry?.fetchedAt).toBe(fetchedAt);
    harness.tracker.dispose();
  });

  it("reads Codex usage through a live session's app-server when there is one", async () => {
    const readLiveAccountRateLimits = vi.fn(async () => ({ live: true }));
    const harness = createTracker({
      codexSessions: { readLiveAccountRateLimits },
    });
    harness.codexPublicState.updateState((draft) => {
      draft.accounts = [managedCodexAccount("codex-1")];
    });

    harness.tracker.start();
    await vi.waitFor(() => {
      expect(harness.entries()["codex:codex-1"]?.status).toBe("ok");
    });

    const options = codexUsageMocks.getCodexUsage.mock.calls.at(-1)?.[0];
    expect(options.externalAuth.accessToken).toBe("token-codex-1");
    await expect(options.readRateLimits()).resolves.toEqual({ live: true });
    expect(readLiveAccountRateLimits).toHaveBeenCalledWith("codex-1");
    harness.tracker.dispose();
  });

  it("adds and prunes entries as accounts come and go", async () => {
    const harness = createTracker();
    harness.tracker.start();
    await vi.waitFor(() => {
      expect(harness.entries()["claude:default"]?.status).toBe("ok");
    });

    harness.claudePublicState.updateState((draft) => {
      draft.accounts = [managedClaudeAccount("claude-1")];
    });
    await vi.waitFor(() => {
      expect(harness.entries()["claude:claude-1"]?.status).toBe("ok");
    });

    harness.claudePublicState.updateState((draft) => {
      draft.accounts = [];
    });
    await vi.waitFor(() => {
      expect(harness.entries()["claude:claude-1"]).toBeUndefined();
    });
    harness.tracker.dispose();
  });

  it("refetches an account that becomes usable again", async () => {
    const harness = createTracker();
    harness.claudePublicState.updateState((draft) => {
      draft.accounts = [
        { ...managedClaudeAccount("claude-1"), status: "needs-relogin" },
      ];
    });

    harness.tracker.start();
    await vi.waitFor(() => {
      expect(harness.entries()["claude:claude-1"]?.status).toBe("unsupported");
    });

    harness.claudePublicState.updateState((draft) => {
      draft.accounts = [managedClaudeAccount("claude-1")];
    });
    await vi.waitFor(() => {
      expect(harness.entries()["claude:claude-1"]?.status).toBe("ok");
    });
    harness.tracker.dispose();
  });

  it("polls again on the refresh interval", async () => {
    vi.useFakeTimers();
    const harness = createTracker({ refreshIntervalMs: 1_000 });
    harness.tracker.start();
    await vi.waitFor(() => {
      expect(cursorUsageMocks.getCursorUsage).toHaveBeenCalledOnce();
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(cursorUsageMocks.getCursorUsage).toHaveBeenCalledTimes(2);
    });
    harness.tracker.dispose();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(cursorUsageMocks.getCursorUsage).toHaveBeenCalledTimes(2);
  });

  it("persists entries as settled", async () => {
    const harness = createTracker();
    harness.tracker.start();
    await vi.waitFor(() => {
      expect(harness.entries()["cursor:default"]?.status).toBe("ok");
    });
    harness.tracker.dispose();

    harness.state.updateState((draft) => {
      const entry = draft.entries["cursor:default"];
      if (entry) {
        entry.refreshing = true;
      }
    });

    const registration = defineUsagePersistence(harness.state);
    const persisted = registration.toPersisted?.(harness.state.state);
    const parsed = registration.schema.safeParse(persisted);

    expect(parsed.success).toBe(true);
    expect(parsed.data?.entries["cursor:default"]).toMatchObject({
      provider: "cursor",
      status: "ok",
      refreshing: false,
      data: CURSOR_USAGE,
    });
  });
});
