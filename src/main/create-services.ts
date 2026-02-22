import { createDisposable } from "@shared/utils";
import { ensureManagedClaudeStatePlugin } from "./claude-state-plugin";
import { CodexSessionLogFileManager } from "./codex-session-log-file-manager";
import { generateCodexSessionTitle } from "./generate-codex-session-title";
import log from "./logger";
import { PersistenceOrchestrator } from "./persistence-orchestrator";
import { PowerSaveBlockerManager } from "./power-save-blocker-manager";
import {
  defineProjectState,
  defineProjectStatePersistence,
} from "./project-service";
import { readProjectSettingsForAll } from "./project-settings-file";
import { SessionsServiceNew } from "./session-service";
import { SessionStateFileManager } from "./session-state-file-manager";
import { SessionTitleManager } from "./session-title-manager";
import { CodexSessionsManager } from "./sessions/codex.session";
import { LocalTerminalSessionsManager } from "./sessions/local-terminal.session";
import { RalphLoopSessionsManager } from "./sessions/ralph-loop.session";
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
  const codexTitleManager = new SessionTitleManager({
    generateTitle: generateCodexSessionTitle,
  });

  const stateFileManager = new SessionStateFileManager(userDataPath);
  const codexSessionLogFileManager = new CodexSessionLogFileManager(
    userDataPath,
  );

  const persistenceService = new PersistenceOrchestrator({
    schemaVersion: STORAGE_SCHEMA_VERSION,
  });

  const projectsState = defineProjectState();
  persistenceService.registerAndHydrate(
    defineProjectStatePersistence(projectsState),
  );

  // Hydrate project defaults from .claude-ui/settings.jsonc files
  const projectPaths = projectsState.state.map((p) => p.path);
  if (projectPaths.length > 0) {
    const fileSettings = await readProjectSettingsForAll(projectPaths);
    if (fileSettings.size > 0) {
      projectsState.updateState((projects) => {
        for (const project of projects) {
          const settings = fileSettings.get(project.path);
          if (!settings) continue;
          Object.assign(project, settings);
        }
      });
    }
  }

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
  const codexSessionsManager = new CodexSessionsManager({
    state: sessionsState,
    titleManager: codexTitleManager,
    sessionLogFileManager: codexSessionLogFileManager,
  });
  const ralphLoopSessionsManager = new RalphLoopSessionsManager({
    pluginDir: managedPluginDir,
    state: sessionsState,
    stateFileManager,
  });
  const powerSaveBlockerManager = new PowerSaveBlockerManager(sessionsState);

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
  shutdownDisposable.addDisposable(
    async () => await localTerminalSessionsManager.dispose(),
  );
  shutdownDisposable.addDisposable(
    async () => await codexSessionsManager.dispose(),
  );
  shutdownDisposable.addDisposable(
    async () => await ralphLoopSessionsManager.dispose(),
  );
  shutdownDisposable.addDisposable(() => powerSaveBlockerManager.dispose());
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
      codex: codexSessionsManager,
      ralphLoop: ralphLoopSessionsManager,
    },
  };
}

export type Services = Awaited<ReturnType<typeof createServices>>;

export type SyncState = Services["stateService"]["~stateMap"];
