import type { ArtifactLocation } from "@main/artifacts-service";

export function canDeleteArtifactFile(
  location: ArtifactLocation | undefined,
): boolean {
  return (
    location !== undefined && !(location.kind === "project" && location.tracked)
  );
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

export function describeCleanupResult(result: {
  removedArtifacts: number;
  removedScreenshots: number;
}): string {
  const parts = [
    result.removedArtifacts
      ? count(result.removedArtifacts, "missing artifact")
      : null,
    result.removedScreenshots
      ? count(result.removedScreenshots, "old preview screenshot")
      : null,
  ].filter((part) => part !== null);
  return parts.length
    ? `Removed ${parts.join(" and ")}`
    : "Nothing to clean up";
}

export function describeDeleteResult(result: {
  deleted: number;
  skipped: number;
}): string {
  const deleted = `Deleted ${count(result.deleted, "file")}`;
  return result.skipped
    ? `${deleted}, skipped ${result.skipped} that couldn't be deleted safely`
    : deleted;
}
