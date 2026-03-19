import { describe, expect, it } from "vitest";
import {
  filterVisibleBranches,
  getInitialActiveBranch,
  getNextActiveBranch,
} from "../../src/renderer/src/components/project-worktree-dialog-helpers";

describe("filterVisibleBranches", () => {
  it("filters branches case-insensitively and ignores surrounding whitespace", () => {
    expect(
      filterVisibleBranches(["main", "feature/sidebar", "release"], "  SIDe  "),
    ).toEqual(["feature/sidebar"]);
  });

  it("returns the full branch list for an empty query", () => {
    expect(filterVisibleBranches(["main", "develop"], "   ")).toEqual([
      "main",
      "develop",
    ]);
  });
});

describe("getInitialActiveBranch", () => {
  it("prefers the selected branch when it is visible", () => {
    expect(
      getInitialActiveBranch(["main", "develop", "feature"], "develop"),
    ).toBe("develop");
  });

  it("falls back to the first visible branch when the selection is hidden", () => {
    expect(getInitialActiveBranch(["feature", "main"], "develop")).toBe(
      "feature",
    );
  });
});

describe("getNextActiveBranch", () => {
  it("moves to the next branch and wraps to the beginning", () => {
    expect(
      getNextActiveBranch(["main", "develop", "feature"], "feature", "next"),
    ).toBe("main");
  });

  it("moves to the previous branch and wraps to the end", () => {
    expect(
      getNextActiveBranch(["main", "develop", "feature"], "main", "previous"),
    ).toBe("feature");
  });

  it("starts from the first or last visible branch when nothing is active", () => {
    expect(getNextActiveBranch(["main", "develop"], null, "next")).toBe("main");
    expect(getNextActiveBranch(["main", "develop"], null, "previous")).toBe(
      "develop",
    );
  });

  it("returns null when there are no visible branches", () => {
    expect(getNextActiveBranch([], "main", "next")).toBeNull();
  });
});
