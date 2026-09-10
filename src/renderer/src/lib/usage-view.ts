import type { UsageEntry } from "@renderer/hooks/use-account-usage";
import { formatPlanType } from "@renderer/lib/plan-label";
import { type UsageProvider, usageEntryKey } from "@shared/usage-keys";

export interface UsageAccountSummary {
  id: string;
  label: string;
  type?: "managed" | "setup-token";
  planType?: string;
  status: "ok" | "needs-relogin";
}

export interface UsageRow {
  key: string;
  provider: UsageProvider;
  accountId: string | null;
  label: string;
  badges: string[];
  needsRelogin: boolean;
  entry: UsageEntry | null;
}

export interface UsageProviderGroup {
  provider: UsageProvider;
  rows: UsageRow[];
}

const DEFAULT_LOGIN_LABEL = "Default account";

function rowsForProvider(
  provider: UsageProvider,
  accounts: UsageAccountSummary[],
  entries: Record<string, UsageEntry>,
): UsageRow[] {
  const rows: UsageRow[] = [
    {
      key: usageEntryKey(provider, null),
      provider,
      accountId: null,
      label: DEFAULT_LOGIN_LABEL,
      badges: ["CLI login"],
      needsRelogin: false,
      entry: entries[usageEntryKey(provider, null)] ?? null,
    },
  ];

  for (const account of accounts) {
    const badges: string[] = [];
    if (account.type === "setup-token") {
      badges.push("Setup token");
    }
    const planLabel = formatPlanType(account.planType);
    if (planLabel) {
      badges.push(planLabel);
    }

    rows.push({
      key: usageEntryKey(provider, account.id),
      provider,
      accountId: account.id,
      label: account.label,
      badges,
      needsRelogin: account.status === "needs-relogin",
      entry: entries[usageEntryKey(provider, account.id)] ?? null,
    });
  }

  return rows;
}

export function buildUsageGroups(input: {
  entries: Record<string, UsageEntry>;
  claudeAccounts: UsageAccountSummary[];
  codexAccounts: UsageAccountSummary[];
}): UsageProviderGroup[] {
  return [
    {
      provider: "claude",
      rows: rowsForProvider("claude", input.claudeAccounts, input.entries),
    },
    {
      provider: "codex",
      rows: rowsForProvider("codex", input.codexAccounts, input.entries),
    },
    { provider: "cursor", rows: rowsForProvider("cursor", [], input.entries) },
  ];
}

export function formatUsageAge(
  fetchedAt: number | null,
  now: number = Date.now(),
): string | null {
  if (fetchedAt == null) {
    return null;
  }

  const seconds = Math.max(0, Math.round((now - fetchedAt) / 1000));
  if (seconds < 45) {
    return "just now";
  }

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  return `${Math.round(hours / 24)}d ago`;
}

export function latestFetchedAt(
  entries: Record<string, UsageEntry>,
): number | null {
  let latest: number | null = null;
  for (const entry of Object.values(entries)) {
    if (
      entry.fetchedAt != null &&
      (latest == null || entry.fetchedAt > latest)
    ) {
      latest = entry.fetchedAt;
    }
  }
  return latest;
}

export function isAnyUsageRefreshing(
  entries: Record<string, UsageEntry>,
): boolean {
  return Object.values(entries).some((entry) => entry.refreshing);
}
