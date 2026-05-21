interface ThrottledAsyncRunner {
  schedule: () => Promise<void>;
  flush: () => Promise<void>;
  dispose: () => void;
}

interface ThrottledAsyncRunnerOptions {
  leading?: boolean;
  trailing?: boolean;
}

export function withThrottledAsyncRunner(
  callback: () => Promise<void>,
  waitMs: number,
  options: ThrottledAsyncRunnerOptions = {},
): ThrottledAsyncRunner {
  const leading = options.leading ?? true;
  const trailing = options.trailing ?? true;

  let lastInvokeTime = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hasPendingCall = false;
  let disposed = false;
  let inFlight: Promise<void> = Promise.resolve();
  let pendingWaiters: Array<() => void> = [];

  const clearTimer = (): void => {
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    timer = null;
  };

  const resolvePendingWaiters = (): void => {
    if (pendingWaiters.length === 0) {
      return;
    }

    const waiters = pendingWaiters;
    pendingWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  };

  const invoke = (): Promise<void> => {
    lastInvokeTime = Date.now();
    hasPendingCall = false;
    inFlight = callback()
      .catch(() => undefined)
      .finally(() => {
        resolvePendingWaiters();
      });
    return inFlight;
  };

  const scheduleTrailing = (): void => {
    if (!trailing || timer || disposed) {
      return;
    }

    const elapsed = lastInvokeTime === 0 ? waitMs : Date.now() - lastInvokeTime;
    const delay = Math.max(0, waitMs - elapsed);

    timer = setTimeout(() => {
      timer = null;
      if (disposed || !hasPendingCall) {
        resolvePendingWaiters();
        return;
      }

      void invoke();
    }, delay);
  };

  const schedule = (): Promise<void> => {
    if (disposed) {
      return Promise.resolve();
    }

    hasPendingCall = true;
    const now = Date.now();
    const shouldInvokeNow =
      lastInvokeTime === 0 || now - lastInvokeTime >= waitMs;

    if (shouldInvokeNow) {
      clearTimer();
      if (leading) {
        return invoke();
      }

      scheduleTrailing();
      return new Promise((resolve) => {
        pendingWaiters.push(resolve);
      });
    }

    scheduleTrailing();
    return new Promise((resolve) => {
      pendingWaiters.push(resolve);
    });
  };

  const flush = async (): Promise<void> => {
    if (disposed) {
      return;
    }

    clearTimer();
    if (hasPendingCall) {
      await invoke();
      return;
    }

    await inFlight;
  };

  const dispose = (): void => {
    if (disposed) {
      return;
    }

    disposed = true;
    clearTimer();
    resolvePendingWaiters();
  };

  return {
    schedule,
    flush,
    dispose,
  };
}
