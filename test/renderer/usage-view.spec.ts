import { describe, expect, it } from "vitest";
import type { UsageEntry } from "../../src/renderer/src/hooks/use-account-usage";
import {
  buildUsageGroups,
  formatUsageAge,
  isAnyUsageRefreshing,
  latestFetchedAt,
} from "../../src/renderer/src/lib/usage-view";

function entry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    provider: "claude",
    accountId: null,
    status: "ok",
    error: null,
    fetchedAt: 1_000,
    refreshing: false,
    data: null,
    ...overrides,
  } as UsageEntry;
}

describe("buildUsageGroups", () => {
  it("lists the default login plus every account per provider", () => {
    const groups = buildUsageGroups({
      entries: {
        "claude:default": entry(),
        "claude:acc-1": entry({ accountId: "acc-1" }),
      },
      claudeAccounts: [
        {
          id: "acc-1",
          label: "Work",
          type: "managed",
          planType: "max_20x",
          status: "ok",
        },
        {
          id: "acc-2",
          label: "Token",
          type: "setup-token",
          status: "ok",
        },
      ],
      codexAccounts: [
        {
          id: "cdx-1",
          label: "Personal",
          type: "managed",
          status: "needs-relogin",
        },
      ],
    });

    expect(groups.map((group) => group.provider)).toEqual([
      "claude",
      "codex",
      "cursor",
    ]);

    const claude = groups[0];
    expect(claude.rows.map((row) => [row.key, row.label])).toEqual([
      ["claude:default", "Default account"],
      ["claude:acc-1", "Work"],
      ["claude:acc-2", "Token"],
    ]);
    expect(claude.rows[0].badges).toEqual(["CLI login"]);
    expect(claude.rows[1].badges).toEqual(["Max 20x"]);
    expect(claude.rows[2].badges).toEqual(["Setup token"]);
    expect(claude.rows[1].entry?.accountId).toBe("acc-1");
    expect(claude.rows[2].entry).toBeNull();

    const codex = groups[1];
    expect(codex.rows[1].needsRelogin).toBe(true);
    expect(groups[2].rows.map((row) => row.key)).toEqual(["cursor:default"]);
  });
});

describe("formatUsageAge", () => {
  const now = Date.parse("2026-09-09T12:00:00.000Z");

  it("returns null without a reading", () => {
    expect(formatUsageAge(null, now)).toBeNull();
  });

  it("formats recent, minute, hour and day ages", () => {
    expect(formatUsageAge(now - 5_000, now)).toBe("just now");
    expect(formatUsageAge(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatUsageAge(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatUsageAge(now - 50 * 3_600_000, now)).toBe("2d ago");
  });
});

describe("latestFetchedAt", () => {
  it("picks the newest reading and ignores entries without one", () => {
    expect(
      latestFetchedAt({
        a: entry({ fetchedAt: 10 }),
        b: entry({ fetchedAt: null }),
        c: entry({ fetchedAt: 40 }),
      }),
    ).toBe(40);
  });

  it("returns null when nothing has been read", () => {
    expect(latestFetchedAt({ a: entry({ fetchedAt: null }) })).toBeNull();
  });
});

describe("isAnyUsageRefreshing", () => {
  it("reports whether any entry is in flight", () => {
    expect(isAnyUsageRefreshing({ a: entry() })).toBe(false);
    expect(
      isAnyUsageRefreshing({ a: entry(), b: entry({ refreshing: true }) }),
    ).toBe(true);
  });
});
