const coarsePointerQuery = window.matchMedia("(pointer: coarse)");

/** True on touch devices (phones/tablets), where keyboard-centric affordances
 * like autofocus and Enter-to-submit hurt more than they help. */
export function isCoarsePointer(): boolean {
  return coarsePointerQuery.matches;
}
