import type { AppHost } from "./app-host";
import { createServices, type Services } from "./create-services";
import log from "./logger";
import { MCP_PATH } from "./mcp/server";
import { McpSessionTokens } from "./mcp/session-token";
import { startWebAppServer } from "./web-app-server";

export const APP_SHUTDOWN_TIMEOUT_MS = 8000;

export async function waitForShutdownWithTimeout(
  shutdownWork: Promise<void>,
  timeoutMs = APP_SHUTDOWN_TIMEOUT_MS,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const completed = await Promise.race([
    shutdownWork.then(() => true),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  return completed;
}

export interface AppRuntime {
  services: Services;
  url: string;
  shutdown(): Promise<void>;
}

interface StartAppRuntimeOptions {
  host: AppHost;
  rendererDist: string;
  viteDevServerUrl?: string;
}

export async function startAppRuntime(
  options: StartAppRuntimeOptions,
): Promise<AppRuntime> {
  const disposeController = new AbortController();
  let services: Services | null = null;
  let webAppServer: Awaited<ReturnType<typeof startWebAppServer>> | null = null;
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = () => {
    shutdownPromise ??= (async () => {
      disposeController.abort();
      const shutdownWork = (async () => {
        const results = await Promise.allSettled([
          webAppServer?.close(),
          services?.shutdown(),
        ]);
        for (const result of results) {
          if (result.status === "rejected") {
            log.error("Failed during app shutdown", { error: result.reason });
          }
        }
      })();
      if (!(await waitForShutdownWithTimeout(shutdownWork))) {
        log.warn("App shutdown timed out", {
          timeoutMs: APP_SHUTDOWN_TIMEOUT_MS,
        });
      }
    })();
    return shutdownPromise;
  };

  try {
    log.info("App starting", {
      mode: options.host.mode,
      platform: process.platform,
      userDataPath: options.host.paths.userData,
    });

    const mcpSessionTokens = new McpSessionTokens();
    services = await createServices({
      host: options.host,
      disposeSignal: disposeController.signal,
      mcpSessionTokens,
      // Sessions only spawn once the UI is reachable, so by the time this
      // getter runs the web server URL (with its actual bound port) is set.
      // The token ties the request back to the session's cwd.
      getMcpServerUrl: (context) =>
        webAppServer
          ? `${webAppServer.url}${MCP_PATH}?token=${mcpSessionTokens.sign(context)}`
          : null,
      getWebAppUrl: () => webAppServer?.url ?? null,
    });

    log.info("Plugin initialization result", {
      pluginDir: services.managedPluginDir,
      pluginWarning: services.pluginWarning,
    });

    webAppServer = await startWebAppServer({
      rendererDist: options.rendererDist,
      viteDevServerUrl: options.viteDevServerUrl,
      getServices: () => services,
    });

    return {
      services,
      url: webAppServer.url,
      shutdown,
    };
  } catch (error) {
    await shutdown();
    throw error;
  }
}
