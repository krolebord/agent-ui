/** Turns provider plan identifiers ("max_20x", "pro-plus") into display text. */
export function formatPlanType(
  planType: string | null | undefined,
): string | null {
  if (!planType) {
    return null;
  }
  return planType
    .split(/[_-]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
