import path from "node:path";
import type { LevelOption } from "electron-log";
import log from "electron-log/node";

const isDev = !!process.env.VITE_DEV_SERVER_URL;
const env = process.env.VITEST ? "test" : isDev ? "dev" : "prod";

/**
 * electron-log serializes an Error to its `stack` alone, which drops
 * `error.cause` and any extra properties such as `code`. Wrapped errors then
 * log only the outermost message, hiding the actual failure. Expand errors into
 * plain objects instead, following the cause chain.
 */
const MAX_VALUE_DEPTH = 6;
const MAX_CAUSE_DEPTH = 5;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializeError(
  error: Error,
  causeDepth: number,
  seen: WeakSet<object>,
): unknown {
  if (causeDepth > MAX_CAUSE_DEPTH) {
    return "[cause chain truncated]";
  }

  const serialized: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };

  // Own enumerable properties carry the useful details on system errors
  // (`code`, `errno`, `syscall`, `path`) and on custom error subclasses.
  for (const key of Object.keys(error)) {
    if (key === "name" || key === "message" || key === "stack") {
      continue;
    }
    if (key === "cause" || key === "errors") {
      continue;
    }
    serialized[key] = serializeValue(
      (error as unknown as Record<string, unknown>)[key],
      0,
      seen,
    );
  }

  if (error.cause !== undefined) {
    serialized.cause = serializeCause(error.cause, causeDepth + 1, seen);
  }

  if (error instanceof AggregateError) {
    serialized.errors = error.errors.map((child) =>
      serializeCause(child, causeDepth + 1, seen),
    );
  }

  return serialized;
}

function serializeCause(
  cause: unknown,
  causeDepth: number,
  seen: WeakSet<object>,
): unknown {
  return cause instanceof Error
    ? serializeError(cause, causeDepth, seen)
    : serializeValue(cause, 0, seen);
}

function serializeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value instanceof Error) {
    if (seen.has(value)) {
      return "[circular]";
    }
    seen.add(value);
    return serializeError(value, 0, seen);
  }

  // Leave non-plain objects (Date, Map, Buffer, class instances) to
  // electron-log's own transforms.
  if (
    depth >= MAX_VALUE_DEPTH ||
    (!Array.isArray(value) && !isPlainObject(value))
  ) {
    return value;
  }

  if (seen.has(value as object)) {
    return "[circular]";
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item, depth + 1, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = serializeValue(item, depth + 1, seen);
  }
  return result;
}

/** Exported for tests. */
export function expandLoggedErrors(data: unknown[]): unknown[] {
  const seen = new WeakSet<object>();
  return data.map((item) => serializeValue(item, 0, seen));
}

log.hooks.push((message) => ({
  ...message,
  data: expandLoggedErrors(message.data),
}));

log.transports.file.level = "info";
log.transports.file.maxSize = 5 * 1024 * 1024;
log.transports.file.format = `[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] [${env}] {text}`;

log.transports.console.level = isDev ? "debug" : "warn";
log.transports.console.format = `[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] [${env}] {text}`;

export function configureLogger(options: {
  logsPath: string;
  fileName: string;
  consoleLevel: LevelOption;
}) {
  log.transports.file.resolvePathFn = () =>
    path.join(options.logsPath, options.fileName);
  log.transports.console.level = options.consoleLevel;
}

export default log;
