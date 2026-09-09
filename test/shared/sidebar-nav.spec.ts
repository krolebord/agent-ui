import { describe, expect, it } from "vitest";
import {
  defaultPinnedItems,
  isNavPageId,
  navPageIds,
  normalizePinnedItems,
  pinnableItemIds,
} from "../../src/shared/sidebar-nav";

describe("normalizePinnedItems", () => {
  it("orders pins the way the overflow menu lists them", () => {
    expect(
      normalizePinnedItems(["usage", "skills", "sidebarView", "accounts"]),
    ).toEqual(["sidebarView", "skills", "accounts", "usage"]);
  });

  it("drops duplicates and unknown ids from older settings", () => {
    expect(
      normalizePinnedItems(["usage", "usage", "inbox", "somethingRemoved"]),
    ).toEqual(["usage"]);
  });

  it("keeps every item when all are pinned", () => {
    expect(normalizePinnedItems([...pinnableItemIds].reverse())).toEqual([
      ...pinnableItemIds,
    ]);
  });

  it("returns nothing once the last pin is removed", () => {
    expect(normalizePinnedItems([])).toEqual([]);
  });

  it("keeps the sidebar switch pinned out of the box", () => {
    expect(normalizePinnedItems(defaultPinnedItems)).toEqual(["sidebarView"]);
  });
});

describe("isNavPageId", () => {
  it("separates pages from the sidebar switch", () => {
    expect(pinnableItemIds.filter(isNavPageId)).toEqual([...navPageIds]);
  });
});
