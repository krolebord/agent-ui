export type DeferredPromise<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

export function createDeferredPromise<T>(opts?: {
  timeout?: number;
  onTimeout?: () => void;
}): DeferredPromise<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = (value) => {
      if (timeoutId) clearTimeout(timeoutId);
      _resolve(value);
    };
    reject = (reason) => {
      if (timeoutId) clearTimeout(timeoutId);
      _reject(reason);
    };

    if (opts?.timeout) {
      timeoutId = setTimeout(() => {
        _reject(new Error(`Promise timed out after ${opts.timeout}ms`));
        tryCatch(() => opts?.onTimeout?.());
      }, opts.timeout);
    }
  });

  return { promise, resolve, reject };
}

type TryCatchResult<T> =
  | {
      success: true;
      data: T;
    }
  | {
      success: false;
      error: unknown;
    };
export function tryCatch<T>(fn: () => T): TryCatchResult<T> {
  try {
    return {
      success: true,
      data: fn(),
    };
  } catch (error) {
    return {
      success: false,
      error,
    };
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}
