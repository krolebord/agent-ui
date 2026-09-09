/**
 * Full-window pages reachable from the sidebar overflow menu, in the order the
 * menu renders them. Pinned pages also render as icon buttons in the sidebar
 * header, so this order doubles as their left-to-right order there.
 */
export const navPageIds = [
  "skills",
  "globalInstructions",
  "scheduledSessions",
  "accounts",
  "artifacts",
  "usage",
] as const;

export type NavPageId = (typeof navPageIds)[number];

export const navPageLabels: Record<NavPageId, string> = {
  skills: "Skills",
  globalInstructions: "Global instructions",
  scheduledSessions: "Scheduled sessions",
  accounts: "Accounts",
  artifacts: "Artifacts",
  usage: "Usage",
};

/**
 * Everything the sidebar header can hold. The projects/inbox switch is pinnable
 * like the pages are: anyone who lives in one view can reclaim its 36px, and it
 * stays reachable from the overflow menu either way.
 */
export const pinnableItemIds = ["sidebarView", ...navPageIds] as const;

export type PinnableItemId = (typeof pinnableItemIds)[number];

export const defaultPinnedItems: PinnableItemId[] = ["sidebarView"];

export function isNavPageId(id: PinnableItemId): id is NavPageId {
  return id !== "sidebarView";
}

/**
 * Sorts pins into menu order and drops duplicates and ids that no longer exist,
 * so persisted settings from an older build stay usable.
 */
export function normalizePinnedItems(
  pinned: readonly string[],
): PinnableItemId[] {
  return pinnableItemIds.filter((id) => pinned.includes(id));
}
