/** Hide pace until enough of the window has elapsed to be meaningful. */
export const MIN_USAGE_PACE_ELAPSED_PERCENT = 3;

export type UsagePace = {
  elapsedPercent: number;
  /** Elapsed percent minus used percent. Positive is reserve; negative is deficit. */
  deltaPercent: number;
};

export function computeUsagePaceBetween(input: {
  usedPercent: number;
  startMs: number;
  endMs: number;
  now?: number;
}): UsagePace | null {
  if (
    !Number.isFinite(input.startMs) ||
    !Number.isFinite(input.endMs) ||
    input.endMs <= input.startMs
  ) {
    return null;
  }

  const now = input.now ?? Date.now();
  const elapsedPercent =
    ((now - input.startMs) / (input.endMs - input.startMs)) * 100;

  if (
    elapsedPercent < MIN_USAGE_PACE_ELAPSED_PERCENT ||
    elapsedPercent >= 100
  ) {
    return null;
  }

  return {
    elapsedPercent,
    deltaPercent: elapsedPercent - input.usedPercent,
  };
}

export function computeUsagePace(input: {
  usedPercent: number;
  windowSeconds: number;
  resetsAt: string | null;
  now?: number;
}): UsagePace | null {
  if (!input.resetsAt || input.windowSeconds <= 0) {
    return null;
  }

  const resetMs = Date.parse(input.resetsAt);
  if (Number.isNaN(resetMs)) {
    return null;
  }

  return computeUsagePaceBetween({
    usedPercent: input.usedPercent,
    startMs: resetMs - input.windowSeconds * 1_000,
    endMs: resetMs,
    now: input.now,
  });
}

export function formatUsagePaceDelta(deltaPercent: number): string {
  const rounded = Math.round(deltaPercent);
  if (rounded > 0) {
    return `+${rounded}%`;
  }
  return `${rounded}%`;
}

/** Cursor billing-cycle fields are millisecond (or second) epoch strings. */
export function parseEpochMillis(
  value: string | null | undefined,
): number | null {
  if (value == null || !value.trim()) {
    return null;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 1e12 ? numeric * 1_000 : numeric;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
