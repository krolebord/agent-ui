import path from "node:path";
import type { LevelOption } from "electron-log";
import log from "electron-log/node";

const isDev = !!process.env.VITE_DEV_SERVER_URL;
const env = process.env.VITEST ? "test" : isDev ? "dev" : "prod";

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
