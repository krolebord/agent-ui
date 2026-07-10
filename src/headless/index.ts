import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppHost } from "../main/app-host";
import { type AppRuntime, startAppRuntime } from "../main/app-runtime";
import log, { configureLogger } from "../main/logger";
import { resolveHeadlessPaths } from "./paths";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, "..");
const rendererDist = path.join(appRoot, "dist");

function registerFatalErrorLogging() {
  process.on("uncaughtException", (error, origin) => {
    log.error("Uncaught exception", { error, origin });
  });
  process.on("unhandledRejection", (reason) => {
    log.error("Unhandled rejection", { reason });
  });
}

// Some terminals forward Ctrl+C to the whole foreground process group, so a
// single keypress can deliver more than one signal to this process. Ignore
// duplicate signals that arrive within this window so one Ctrl+C performs a
// full graceful shutdown; a deliberate second press after the window forces an
// immediate exit.
const FORCE_EXIT_GRACE_MS = 1000;

function registerSignalHandlers(runtime: AppRuntime) {
  let shutdownStartedAt: number | null = null;
  const handleSignal = (signal: NodeJS.Signals) => {
    if (shutdownStartedAt !== null) {
      if (Date.now() - shutdownStartedAt < FORCE_EXIT_GRACE_MS) {
        log.debug("Ignoring duplicate termination signal", { signal });
        return;
      }
      log.warn("Second termination signal received; forcing exit", { signal });
      process.exit(1);
    }
    shutdownStartedAt = Date.now();
    log.info("Shutting down", { signal });
    void runtime.shutdown().then(() => process.exit(0));
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
}

async function main() {
  const paths = resolveHeadlessPaths();
  configureLogger({
    logsPath: paths.logs,
    fileName: "headless.log",
    consoleLevel: "info",
  });
  registerFatalErrorLogging();

  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("Headless mode currently supports macOS and Linux only.");
  }

  await access(path.join(rendererDist, "index.html")).catch(() => {
    throw new Error(
      'Renderer build not found. Run "pnpm build:headless" before starting headless mode.',
    );
  });

  process.env.APP_ROOT = appRoot;
  process.env.VITE_PUBLIC = rendererDist;

  const host: AppHost = {
    mode: "headless",
    paths,
    desktop: null,
  };
  const runtime = await startAppRuntime({ host, rendererDist });
  process.stdout.write(`Agent UI listening at ${runtime.url}\n`);
  registerSignalHandlers(runtime);
}

void main().catch((error) => {
  log.error("Failed to start headless mode", { error });
  process.exitCode = 1;
});
