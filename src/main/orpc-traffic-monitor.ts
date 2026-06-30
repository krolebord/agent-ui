import log from "./logger";

type ProcedureClientInterceptorOptions = {
  input: unknown;
  path: readonly string[];
  next: () => Promise<unknown>;
};

interface ProcedureTrafficStats {
  calls: number;
  errors: number;
  inputBytes: number;
  outputBytes: number;
  streamEvents: number;
  streamBytes: number;
  activeStreams: number;
  completedStreams: number;
  totalDurationMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  maxStreamEventBytes: number;
}

interface TrafficMonitorOptions {
  enabled?: boolean;
  intervalMs?: number;
  topPaths?: number;
  ignoredPaths?: readonly string[];
}

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_TOP_PATHS = 20;

function getByteSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
}

function isAsyncIterator(value: unknown): value is AsyncIterator<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "next" in value &&
    typeof (value as { next?: unknown }).next === "function"
  );
}

function createEmptyStats(): ProcedureTrafficStats {
  return {
    calls: 0,
    errors: 0,
    inputBytes: 0,
    outputBytes: 0,
    streamEvents: 0,
    streamBytes: 0,
    activeStreams: 0,
    completedStreams: 0,
    totalDurationMs: 0,
    maxInputBytes: 0,
    maxOutputBytes: 0,
    maxStreamEventBytes: 0,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

export function createORPCTrafficMonitor(options: TrafficMonitorOptions = {}) {
  const envEnabled = process.env.ORPC_TRAFFIC_MONITOR;
  const enabled =
    options.enabled ??
    (envEnabled != null
      ? envEnabled === "1"
      : process.env.ORPC_TRAFFIC_LOG === "1" ||
        Boolean(process.env.VITE_DEV_SERVER_URL));

  const intervalMs = Number(
    process.env.ORPC_TRAFFIC_INTERVAL_MS ?? options.intervalMs,
  );
  const topPaths = Number(
    process.env.ORPC_TRAFFIC_TOP_PATHS ?? options.topPaths,
  );
  const reportIntervalMs = Number.isFinite(intervalMs)
    ? intervalMs
    : DEFAULT_INTERVAL_MS;
  const reportTopPaths = Number.isFinite(topPaths)
    ? topPaths
    : DEFAULT_TOP_PATHS;
  const ignoredPaths = new Set(options.ignoredPaths ?? []);

  const statsByPath = new Map<string, ProcedureTrafficStats>();
  let lastReportAt = Date.now();
  let lastActivityAt = 0;

  const getStats = (path: readonly string[]) => {
    const pathKey = path.join(".");
    let stats = statsByPath.get(pathKey);
    if (!stats) {
      stats = createEmptyStats();
      statsByPath.set(pathKey, stats);
    }
    return stats;
  };

  const markActivity = () => {
    lastActivityAt = Date.now();
  };

  const recordStreamEvent = (stats: ProcedureTrafficStats, event: unknown) => {
    const bytes = getByteSize(event);
    stats.streamEvents += 1;
    stats.streamBytes += bytes;
    stats.maxStreamEventBytes = Math.max(stats.maxStreamEventBytes, bytes);
    markActivity();
  };

  async function* measureStream(
    iterator: AsyncIterator<unknown>,
    stats: ProcedureTrafficStats,
  ) {
    stats.activeStreams += 1;
    markActivity();
    try {
      while (true) {
        const result = await iterator.next();
        if (result.done) {
          return result.value;
        }
        recordStreamEvent(stats, result.value);
        yield result.value;
      }
    } finally {
      stats.activeStreams = Math.max(0, stats.activeStreams - 1);
      stats.completedStreams += 1;
      markActivity();
      await iterator.return?.();
    }
  }

  const interceptor = async (
    interceptorOptions: ProcedureClientInterceptorOptions,
  ) => {
    if (!enabled || ignoredPaths.has(interceptorOptions.path.join("."))) {
      return interceptorOptions.next();
    }

    const stats = getStats(interceptorOptions.path);
    const inputBytes = getByteSize(interceptorOptions.input);
    const startedAt = performance.now();

    stats.calls += 1;
    stats.inputBytes += inputBytes;
    stats.maxInputBytes = Math.max(stats.maxInputBytes, inputBytes);
    markActivity();

    try {
      const output = await interceptorOptions.next();
      stats.totalDurationMs += performance.now() - startedAt;

      if (isAsyncIterator(output)) {
        return measureStream(output, stats);
      }

      const outputBytes = getByteSize(output);
      stats.outputBytes += outputBytes;
      stats.maxOutputBytes = Math.max(stats.maxOutputBytes, outputBytes);
      markActivity();
      return output;
    } catch (error) {
      stats.errors += 1;
      stats.totalDurationMs += performance.now() - startedAt;
      markActivity();
      throw error;
    }
  };

  const getSnapshot = () => {
    const paths = Array.from(statsByPath.entries())
      .map(([path, stats]) => {
        const totalBytes =
          stats.inputBytes + stats.outputBytes + stats.streamBytes;
        return {
          path,
          calls: stats.calls,
          errors: stats.errors,
          inputBytes: stats.inputBytes,
          outputBytes: stats.outputBytes,
          streamEvents: stats.streamEvents,
          streamBytes: stats.streamBytes,
          totalBytes,
          totalBytesFormatted: formatBytes(totalBytes),
          activeStreams: stats.activeStreams,
          completedStreams: stats.completedStreams,
          avgDurationMs:
            stats.calls > 0
              ? Math.round((stats.totalDurationMs / stats.calls) * 10) / 10
              : 0,
          maxInputBytes: stats.maxInputBytes,
          maxOutputBytes: stats.maxOutputBytes,
          maxStreamEventBytes: stats.maxStreamEventBytes,
        };
      })
      .sort((a, b) => b.totalBytes - a.totalBytes);

    const totals = paths.reduce(
      (acc, item) => {
        acc.calls += item.calls;
        acc.errors += item.errors;
        acc.inputBytes += item.inputBytes;
        acc.outputBytes += item.outputBytes;
        acc.streamEvents += item.streamEvents;
        acc.streamBytes += item.streamBytes;
        acc.totalBytes += item.totalBytes;
        acc.activeStreams += item.activeStreams;
        acc.completedStreams += item.completedStreams;
        return acc;
      },
      {
        calls: 0,
        errors: 0,
        inputBytes: 0,
        outputBytes: 0,
        streamEvents: 0,
        streamBytes: 0,
        totalBytes: 0,
        activeStreams: 0,
        completedStreams: 0,
      },
    );

    return {
      enabled,
      generatedAt: new Date().toISOString(),
      sinceLastReportMs: Date.now() - lastReportAt,
      totals: {
        ...totals,
        totalBytesFormatted: formatBytes(totals.totalBytes),
      },
      topPaths: paths.slice(0, reportTopPaths),
    };
  };

  const flush = (reason: "interval" | "shutdown" | "manual" = "manual") => {
    if (!enabled || statsByPath.size === 0) {
      return;
    }

    const snapshot = getSnapshot();
    lastReportAt = Date.now();
    log.info("[orpc-traffic]", JSON.stringify({ reason, ...snapshot }));
  };

  const interval =
    enabled && reportIntervalMs > 0
      ? setInterval(() => {
          if (lastActivityAt <= lastReportAt) {
            return;
          }
          flush("interval");
        }, reportIntervalMs)
      : null;

  interval?.unref();

  if (enabled) {
    log.info("[orpc-traffic] enabled", {
      intervalMs: reportIntervalMs,
      topPaths: reportTopPaths,
    });
  }

  return {
    interceptor,
    getSnapshot,
    flush,
    dispose: () => {
      flush("shutdown");
      if (interval) {
        clearInterval(interval);
      }
    },
  };
}

export const orpcTrafficMonitor = createORPCTrafficMonitor({
  ignoredPaths: ["diagnostics.getOrpcTrafficSnapshot"],
});

export type ORPCTrafficSnapshot = ReturnType<
  typeof orpcTrafficMonitor.getSnapshot
>;
