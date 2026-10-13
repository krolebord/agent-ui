export const navPageIds = [
  "skills",
  "globalInstructions",
  "scheduledSessions",
  "accounts",
  "artifacts",
  "usage",
  "limits",
  "memory",
] as const;

export type NavPageId = (typeof navPageIds)[number];

export const navPageLabels: Record<NavPageId, string> = {
  skills: "Skills",
  globalInstructions: "Global instructions",
  scheduledSessions: "Scheduled sessions",
  accounts: "Accounts",
  artifacts: "Artifacts",
  usage: "Usage",
  limits: "Limits",
  memory: "Memory",
};

export const pinnableItemIds = ["sidebarView", ...navPageIds] as const;

export type PinnableItemId = (typeof pinnableItemIds)[number];

export const defaultPinnedItems: PinnableItemId[] = ["sidebarView"];

export function isNavPageId(id: PinnableItemId): id is NavPageId {
  return id !== "sidebarView";
}

export function normalizePinnedItems(
  pinned: readonly string[],
): PinnableItemId[] {
  return pinnableItemIds.filter((id) => pinned.includes(id));
}
