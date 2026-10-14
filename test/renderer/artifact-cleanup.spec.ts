import { describe, expect, it } from "vitest";
import {
  canDeleteArtifactFile,
  describeCleanupResult,
  describeDeleteResult,
} from "../../src/renderer/src/lib/artifact-cleanup";

describe("canDeleteArtifactFile", () => {
  it("allows app storage, untracked project files, and other paths", () => {
    expect(canDeleteArtifactFile({ kind: "app" })).toBe(true);
    expect(canDeleteArtifactFile({ kind: "elsewhere" })).toBe(true);
    expect(
      canDeleteArtifactFile({
        kind: "project",
        projectPath: "/p",
        tracked: false,
      }),
    ).toBe(true);
  });

  it("refuses git-tracked files and artifacts not inspected yet", () => {
    expect(
      canDeleteArtifactFile({
        kind: "project",
        projectPath: "/p",
        tracked: true,
      }),
    ).toBe(false);
    expect(canDeleteArtifactFile(undefined)).toBe(false);
  });
});

describe("cleanup messages", () => {
  it("summarizes what the cleanup removed", () => {
    expect(
      describeCleanupResult({ removedArtifacts: 1, removedScreenshots: 3 }),
    ).toBe("Removed 1 missing artifact and 3 old preview screenshots");
    expect(
      describeCleanupResult({ removedArtifacts: 0, removedScreenshots: 0 }),
    ).toBe("Nothing to clean up");
  });

  it("mentions skipped files only when there are any", () => {
    expect(describeDeleteResult({ deleted: 2, skipped: 0 })).toBe(
      "Deleted 2 files",
    );
    expect(describeDeleteResult({ deleted: 1, skipped: 1 })).toBe(
      "Deleted 1 file, skipped 1 that couldn't be deleted safely",
    );
  });
});
