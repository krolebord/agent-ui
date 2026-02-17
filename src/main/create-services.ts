import { createDisposable } from "@shared/utils";
import { ensureManagedClaudeStatePlugin } from "./claude-state-plugin";
import log from "./logger";
import { PersistenceOrchestrator } from "./persistence-orchestrator";
import {
  defineProjectState,
  defineProjectStatePersistence,
} from "./project-service";
import { SessionsServiceNew } from "./session-service";
import { SessionStateFileManager } from "./session-state-file-manager";
import { SessionTitleManager } from "./session-title-manager";
import { LocalTerminalSessionsManager } from "./sessions/local-terminal.session";
import {
  defineSessionServiceState,
  defineSessionStatePersistence,
} from "./sessions/state";
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

  const sessionsState = defineSessionServiceState();
  persistenceService.registerAndHydrate(
    defineSessionStatePersistence(sessionsState),
  );

  const sessionsService = new SessionsServiceNew({
    pluginDir: managedPluginDir,
    pluginWarning,
    titleManager,
    stateFileManager,
    state: sessionsState,
  });

  const localTerminalSessionsManager = new LocalTerminalSessionsManager(
    sessionsState,
  );

  const stateService = new StateOrchestrator({
    serviceStates: {
      projects: projectsState,
      sessions: sessionsState,
    },
  });

  const shutdownDisposable = createDisposable({
    onError: (error) => {
      log.error("Error while shutting down services", error);
    },
  });

  shutdownDisposable.addDisposable(async () => await sessionsService.dispose());
  shutdownDisposable.addDisposable(() => stateService.dispose());
  shutdownDisposable.addDisposable(() => persistenceService.dispose());

  return {
    projectsState,
    getMainWindow,
    sessionsService,
    stateService,
    shutdown: shutdownDisposable.dispose,
    managedPluginDir,
    pluginWarning,
    sessions: {
      state: sessionsState,
      localTerminal: localTerminalSessionsManager,
    },
  };
}

export type Services = Awaited<ReturnType<typeof createServices>>;

export type SyncState = Services["stateService"]["~stateMap"];
