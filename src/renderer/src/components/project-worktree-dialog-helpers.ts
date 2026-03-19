export function filterVisibleBranches(
  branches: string[],
  query: string,
): string[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();

  if (!normalizedQuery) {
    return branches;
  }

  return branches.filter((branch) =>
    branch.toLocaleLowerCase().includes(normalizedQuery),
  );
}

export function getInitialActiveBranch(
  visibleBranches: string[],
  selectedBranch: string,
): string | null {
  if (selectedBranch && visibleBranches.includes(selectedBranch)) {
    return selectedBranch;
  }

  return visibleBranches[0] ?? null;
}

export function getNextActiveBranch(
  visibleBranches: string[],
  activeBranch: string | null,
  direction: "next" | "previous",
): string | null {
  if (!visibleBranches.length) {
    return null;
  }

  const currentIndex = activeBranch
    ? visibleBranches.indexOf(activeBranch)
    : -1;
  const step = direction === "next" ? 1 : -1;

  if (currentIndex === -1) {
    return direction === "next"
      ? visibleBranches[0]
      : visibleBranches[visibleBranches.length - 1];
  }

  const nextIndex =
    (currentIndex + step + visibleBranches.length) % visibleBranches.length;

  return visibleBranches[nextIndex] ?? null;
}
