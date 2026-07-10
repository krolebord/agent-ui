import type { AppHost } from "./app-host";
import { createServices, type Services } from "./create-services";
import log from "./logger";
import { startWebAppServer } from "./web-app-server";

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
    return shutdownPromise;
  };

  try {
    log.info("App starting", {
      mode: options.host.mode,
      platform: process.platform,
      userDataPath: options.host.paths.userData,
    });

    services = await createServices({
      host: options.host,
      disposeSignal: disposeController.signal,
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
