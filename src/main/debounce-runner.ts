interface DebouncedRunner {
  schedule: () => void;
  flush: () => void;
  dispose: () => void;
}

export function withDebouncedRunner(
  callback: () => void,
  debounceMs: number,
): DebouncedRunner {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearTimer = (): void => {
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    timer = null;
  };

  const flush = (): void => {
    if (disposed) {
      return;
    }

    clearTimer();
    callback();
  };

  const schedule = (): void => {
    if (disposed) {
      return;
    }

    if (debounceMs === 0) {
      flush();
      return;
    }

    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      callback();
    }, debounceMs);
  };

  const dispose = (): void => {
    if (disposed) {
      return;
    }

    clearTimer();
    callback();
    disposed = true;
  };

  return {
    schedule,
    flush,
    dispose,
  };
}
