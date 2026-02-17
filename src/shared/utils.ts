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

export function concatAndTruncate(opts: {
  maxTotalSize: number;
  base: string;
  chunk: string;
}) {
  if (opts.chunk.length >= opts.maxTotalSize) {
    return opts.chunk.slice(opts.chunk.length - opts.maxTotalSize);
  }

  const result = opts.base + opts.chunk;

  if (result.length <= opts.maxTotalSize) {
    return result;
  }

  return result.substring(result.length - opts.maxTotalSize);
}

// biome-ignore lint/suspicious/noExplicitAny: any in generic
export function once<T extends () => any>(fn: T): () => ReturnType<T> {
  let cached: { result: ReturnType<T> } | undefined;

  return (): ReturnType<T> => {
    if (cached) {
      return cached.result;
    }

    const result = fn();
    cached = { result };

    return result;
  };
}

type DisposableFn = () => Promise<unknown> | unknown;
export function createDisposable({
  onError,
}: {
  onError: (error: unknown) => void;
}) {
  let disposed = false;
  const disposables = new Set<DisposableFn>();

  return {
    get isDisposed() {
      return disposed;
    },
    addDisposable: (disposable: DisposableFn) => {
      disposables.add(disposable);
    },
    dispose: once(async () => {
      const results = await Promise.allSettled(
        Array.from(disposables).map(async (disposable) => await disposable()),
      );
      disposables.clear();
      disposed = true;
      for (const result of results) {
        if (result.status === "rejected") {
          onError(result.reason);
        }
      }
    }),
  };
}
