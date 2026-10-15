import type { ArtifactLocation } from "@main/artifacts-service";

export type CleanupMark = "remove" | "delete";

export function canDeleteArtifactFile(
  location: ArtifactLocation | undefined,
): boolean {
  return (
    location !== undefined && !(location.kind === "project" && location.tracked)
  );
}

function getCleanupMarks(
  location: ArtifactLocation | undefined,
): CleanupMark[] {
  if (location?.kind === "app") return ["delete"];
  return canDeleteArtifactFile(location) ? ["remove", "delete"] : ["remove"];
}

export function nextCleanupMark(
  mark: CleanupMark | undefined,
  location: ArtifactLocation | undefined,
): CleanupMark | undefined {
  const marks = getCleanupMarks(location);
  return marks[mark ? marks.indexOf(mark) + 1 : 0];
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

export function describeCleanupResult(result: {
  removedArtifacts: number;
  removedScreenshots: number;
}): string | null {
  const parts = [
    result.removedArtifacts
      ? count(result.removedArtifacts, "missing artifact")
      : null,
    result.removedScreenshots
      ? count(result.removedScreenshots, "old preview screenshot")
      : null,
  ].filter((part) => part !== null);
  return parts.length ? `Removed ${parts.join(" and ")}` : null;
}

export function describeCleanupAction(counts: {
  remove: number;
  delete: number;
}): string {
  const parts = [
    counts.remove ? `Remove ${counts.remove}` : null,
    counts.delete ? `Delete ${count(counts.delete, "file")}` : null,
  ].filter((part) => part !== null);
  return parts.length ? parts.join(" · ") : "Apply";
}

export function describeApplyResult(result: {
  removed: number;
  deleted: number;
  skipped: number;
}): string {
  const parts = [
    result.removed ? `removed ${count(result.removed, "artifact")}` : null,
    result.deleted ? `deleted ${count(result.deleted, "file")}` : null,
    result.skipped
      ? `skipped ${result.skipped} that couldn't be deleted safely`
      : null,
  ].filter((part) => part !== null);
  const message = parts.join(", ") || "nothing changed";
  return message.charAt(0).toUpperCase() + message.slice(1);
}
