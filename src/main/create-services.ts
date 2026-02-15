import { ensureManagedClaudeStatePlugin } from "./claude-state-plugin";
import { PersistenceOrchestrator } from "./persistence-orchestrator";
import {
  defineProjectState,
  defineProjectStatePersistence,
} from "./project-service";
import { SessionsServiceNew } from "./session-service";
import { SessionStateFileManager } from "./session-state-file-manager";
import { SessionTitleManager } from "./session-title-manager";
import { StateOrchestrator } from "./state-orchestrator";

const STORAGE_SCHEMA_VERSION = 3;

interface CreateServicesOptions {
  userDataPath: string;
  getMainWindow: () => Electron.BrowserWindow | null;
  disposeSignal: AbortSignal;
}

interface ManagedPluginInitializationResult {
  managedPluginDir: string | null;
  pluginWarning: string | null;
}

async function initializeManagedPlugin(
  userDataPath: string,
): Promise<ManagedPluginInitializationResult> {
  try {
    const managedPluginDir = await ensureManagedClaudeStatePlugin(userDataPath);
    return {
      managedPluginDir,
      pluginWarning: null,
    };
  } catch (error) {
    return {
      managedPluginDir: null,
      pluginWarning:
        error instanceof Error
          ? `Hook monitoring plugin failed to load: ${error.message}`
          : "Hook monitoring plugin failed to load.",
    };
  }
}

export type CreateServicesResult = Awaited<ReturnType<typeof createServices>>;

export async function createServices(options: CreateServicesOptions) {
  const { userDataPath, getMainWindow } = options;
  const { managedPluginDir, pluginWarning } =
    await initializeManagedPlugin(userDataPath);

  const titleManager = new SessionTitleManager();

  const stateFileManager = new SessionStateFileManager(userDataPath);

  const persistenceService = new PersistenceOrchestrator({
    schemaVersion: STORAGE_SCHEMA_VERSION,
  });

  const projectsState = defineProjectState();
  persistenceService.registerAndHydrate(
    defineProjectStatePersistence(projectsState),
  );

  const sessionsService = new SessionsServiceNew({
    pluginDir: managedPluginDir,
    pluginWarning,
    titleManager,
    stateFileManager,
    persistence: persistenceService,
  });

  const stateService = new StateOrchestrator({
    serviceStates: {
      projects: projectsState,
      sessions: sessionsService.getSyncState(),
    },
  });

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = async (): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      await sessionsService.dispose();
      stateService.dispose();
      persistenceService.dispose();
    })();

    return shutdownPromise;
  };

  return {
    projectsState,
    getMainWindow,
    sessionsService,
    stateService,
    shutdown,
    managedPluginDir,
    pluginWarning,
  };
}

export type Services = Awaited<ReturnType<typeof createServices>>;

export type SyncState = Services["stateService"]["~stateMap"];
