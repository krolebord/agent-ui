import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppHost } from "../main/app-host";
import { type AppRuntime, startAppRuntime } from "../main/app-runtime";
import log, { configureLogger } from "../main/logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, "..");
const rendererDist = path.join(appRoot, "dist");

function resolveUserPath(input: string) {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return path.resolve(input);
}

function resolveHeadlessPaths() {
  const configuredDataPath = process.env.AGENT_UI_DATA_DIR?.trim();
  if (configuredDataPath) {
    const userData = resolveUserPath(configuredDataPath);
    return {
      userData,
      logs: path.join(userData, "logs"),
    };
  }

  return {
    userData: path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "agent-ui",
    ),
    logs: path.join(os.homedir(), "Library", "Logs", "agent-ui"),
  };
}

function registerFatalErrorLogging() {
  process.on("uncaughtException", (error, origin) => {
    log.error("Uncaught exception", { error, origin });
  });
  process.on("unhandledRejection", (reason) => {
    log.error("Unhandled rejection", { reason });
  });
}

function registerSignalHandlers(runtime: AppRuntime) {
  let isShuttingDown = false;
  const handleSignal = (signal: NodeJS.Signals) => {
    if (isShuttingDown) {
      log.warn("Second termination signal received; forcing exit", { signal });
      process.exit(1);
    }
    isShuttingDown = true;
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

  if (process.platform !== "darwin") {
    throw new Error("Headless mode currently supports macOS only.");
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
