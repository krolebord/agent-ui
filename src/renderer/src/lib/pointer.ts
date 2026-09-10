const coarsePointerQuery = window.matchMedia("(pointer: coarse)");

export function isCoarsePointer(): boolean {
  return coarsePointerQuery.matches;
}
