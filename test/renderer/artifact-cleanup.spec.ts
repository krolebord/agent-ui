import { describe, expect, it } from "vitest";
import {
  canDeleteArtifactFile,
  describeApplyResult,
  describeCleanupAction,
  describeCleanupResult,
  nextCleanupMark,
} from "../../src/renderer/src/lib/artifact-cleanup";

const elsewhere = { kind: "elsewhere" } as const;
const tracked = { kind: "project", projectPath: "/p", tracked: true } as const;
const app = { kind: "app" } as const;

describe("canDeleteArtifactFile", () => {
  it("allows app storage, untracked project files, and other paths", () => {
    expect(canDeleteArtifactFile(app)).toBe(true);
    expect(canDeleteArtifactFile(elsewhere)).toBe(true);
    expect(
      canDeleteArtifactFile({
        kind: "project",
        projectPath: "/p",
        tracked: false,
      }),
    ).toBe(true);
  });

  it("refuses git-tracked files and artifacts not inspected yet", () => {
    expect(canDeleteArtifactFile(tracked)).toBe(false);
    expect(canDeleteArtifactFile(undefined)).toBe(false);
  });
});

describe("nextCleanupMark", () => {
  it("cycles through remove, delete, and unmarked", () => {
    expect(nextCleanupMark(undefined, elsewhere)).toBe("remove");
    expect(nextCleanupMark("remove", elsewhere)).toBe("delete");
    expect(nextCleanupMark("delete", elsewhere)).toBeUndefined();
  });

  it("skips delete when the file can't be deleted", () => {
    expect(nextCleanupMark(undefined, tracked)).toBe("remove");
    expect(nextCleanupMark("remove", tracked)).toBeUndefined();
    expect(nextCleanupMark(undefined, undefined)).toBe("remove");
    expect(nextCleanupMark("remove", undefined)).toBeUndefined();
  });

  it("goes straight to delete for app storage, which removal always deletes", () => {
    expect(nextCleanupMark(undefined, app)).toBe("delete");
    expect(nextCleanupMark("delete", app)).toBeUndefined();
  });
});

describe("cleanup messages", () => {
  it("summarizes what the cleanup removed and stays quiet otherwise", () => {
    expect(
      describeCleanupResult({ removedArtifacts: 1, removedScreenshots: 3 }),
    ).toBe("Removed 1 missing artifact and 3 old preview screenshots");
    expect(
      describeCleanupResult({ removedArtifacts: 0, removedScreenshots: 0 }),
    ).toBeNull();
  });

  it("labels the apply button with both counts", () => {
    expect(describeCleanupAction({ remove: 2, delete: 0 })).toBe("Remove 2");
    expect(describeCleanupAction({ remove: 0, delete: 1 })).toBe(
      "Delete 1 file",
    );
    expect(describeCleanupAction({ remove: 2, delete: 3 })).toBe(
      "Remove 2 · Delete 3 files",
    );
    expect(describeCleanupAction({ remove: 0, delete: 0 })).toBe("Apply");
  });

  it("reports removed, deleted, and skipped counts", () => {
    expect(describeApplyResult({ removed: 2, deleted: 0, skipped: 0 })).toBe(
      "Removed 2 artifacts",
    );
    expect(describeApplyResult({ removed: 1, deleted: 2, skipped: 1 })).toBe(
      "Removed 1 artifact, deleted 2 files, skipped 1 that couldn't be deleted safely",
    );
    expect(describeApplyResult({ removed: 0, deleted: 1, skipped: 0 })).toBe(
      "Deleted 1 file",
    );
  });
});
