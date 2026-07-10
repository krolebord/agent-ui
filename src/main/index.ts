import path from "node:path";
import { fileURLToPath } from "node:url";
import fixPath from "fix-path";

fixPath();

import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/message-port";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import type { AppRuntime } from "./app-runtime";
import { startAppRuntime } from "./app-runtime";
import { DesktopIntegrationManager } from "./desktop-integration-manager";
import { createElectronHost } from "./electron-host";
import log, { configureLogger } from "./logger";
import { orpcRouter } from "./orpc-router";

if (process.platform !== "darwin") {
  throw new Error("Only macOS is supported");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, "../..");
const rendererDist = path.join(appRoot, "dist");
const viteDevServerUrl = process.env.VITE_DEV_SERVER_URL;
const shouldOpenDevTools =
  Boolean(viteDevServerUrl) || process.env.ELECTRON_OPEN_DEVTOOLS === "1";

process.env.APP_ROOT = appRoot;
process.env.VITE_PUBLIC = viteDevServerUrl
  ? path.join(appRoot, "public")
  : rendererDist;

const preload = path.join(__dirname, "../preload/index.mjs");
const indexHtml = path.join(rendererDist, "index.html");

let mainWindow: BrowserWindow | null = null;
let runtime: AppRuntime | null = null;
let desktopIntegrationManager: DesktopIntegrationManager | null = null;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Agent UI",
    titleBarStyle: "hidden",
    trafficLightPosition: {
      x: 14,
      y: 10,
    },
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (viteDevServerUrl) {
    await mainWindow.loadURL(viteDevServerUrl);
  } else {
    await mainWindow.loadFile(indexHtml);
  }

  if (shouldOpenDevTools) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (
      url.startsWith("https:") ||
      url.startsWith("http:") ||
      url.startsWith("chrome:") ||
      url.startsWith("file:")
    ) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

const handler = new RPCHandler(orpcRouter, {
  interceptors: [
    onError((error) => {
      log.error("Electron RPC error", { error });
    }),
  ],
});

async function initializeElectronApp() {
  const host = createElectronHost({ getMainWindow: () => mainWindow });
  configureLogger({
    logsPath: host.paths.logs,
    fileName: "main.log",
    consoleLevel: viteDevServerUrl ? "debug" : "warn",
  });

  runtime = await startAppRuntime({
    host,
    rendererDist,
    viteDevServerUrl,
  });
  desktopIntegrationManager = new DesktopIntegrationManager(
    runtime.services.sessions.state,
    runtime.services.appSettingsState,
  );

  ipcMain.on("start-orpc-server", async (event) => {
    if (!runtime) {
      return;
    }

    const [serverPort] = event.ports;
    handler.upgrade(serverPort, {
      context: runtime.services,
    });
    serverPort.start();
  });

  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
}

void app
  .whenReady()
  .then(initializeElectronApp)
  .catch(async (error) => {
    log.error("Failed to start Electron app", { error });
    await runtime?.shutdown();
    app.exit(1);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

let isHandlingBeforeQuit = false;
let hasCompletedShutdown = false;
// biome-ignore lint/correctness/noUnusedVariables: assigned via ??= to keep shutdown alive once
let shutdownPromise: Promise<void> | null = null;

app.on("before-quit", (event) => {
  if (hasCompletedShutdown) {
    return;
  }

  event.preventDefault();
  if (isHandlingBeforeQuit) {
    return;
  }
  isHandlingBeforeQuit = true;

  shutdownPromise ??= (async () => {
    try {
      desktopIntegrationManager?.dispose();
      await runtime?.shutdown();
    } catch (error) {
      log.error("Failed during Electron app shutdown", { error });
    } finally {
      hasCompletedShutdown = true;
      app.quit();
    }
  })();
});
