export type UsageProvider = "claude" | "codex" | "cursor";

export function usageEntryKey(
  provider: UsageProvider,
  accountId: string | null | undefined,
): string {
  return `${provider}:${accountId ?? "default"}`;
}
