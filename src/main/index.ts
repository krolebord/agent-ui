import path from "node:path";
import { fileURLToPath } from "node:url";
import fixPath from "fix-path";
fixPath();

import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/message-port";
import { BrowserWindow, app, ipcMain, shell } from "electron";
import { createServices } from "./create-services";
import log from "./logger";
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
let services: Awaited<ReturnType<typeof createServices>> | null = null;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Claude Wrapper",
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
      console.error(error);
    }),
  ],
});

const disposeController = new AbortController();

app.whenReady().then(async () => {
  const userDataPath = app.getPath("userData");
  log.info("App starting", {
    platform: process.platform,
    userDataPath,
  });

  services = await createServices({
    userDataPath,
    getMainWindow: () => mainWindow,
    disposeSignal: disposeController.signal,
  });

  log.info("Plugin initialization result", {
    pluginDir: services.managedPluginDir,
    pluginWarning: services.pluginWarning,
  });

  log.info("Session service created");

  ipcMain.on("start-orpc-server", async (event) => {
    if (!services) {
      return;
    }

    const [serverPort] = event.ports;
    handler.upgrade(serverPort, {
      context: services,
    });
    serverPort.start();
  });

  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

let isHandlingBeforeQuit = false;
let hasCompletedShutdown = false;
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

  disposeController.abort();

  shutdownPromise ??= (async () => {
    try {
      await services?.shutdown();
    } catch (error) {
      log.error("Failed during app shutdown", { error });
    } finally {
      hasCompletedShutdown = true;
      app.quit();
    }
  })();
});
