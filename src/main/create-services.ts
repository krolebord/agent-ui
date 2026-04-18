import { createDisposable } from "@shared/utils";
import {
  defineAppSettingsPersistence,
  defineAppSettingsState,
} from "./app-settings";
import { ensureManagedClaudeStatePlugin } from "./claude-state-plugin";
import { CursorSessionLogFileManager } from "./cursor-session-log-file-manager";
import { ensureManagedCursorStateHooks } from "./cursor-state-hooks";
import { DesktopIntegrationManager } from "./desktop-integration-manager";
import { generateCodexSessionTitle } from "./generate-codex-session-title";
import log from "./logger";
import { PersistenceOrchestrator } from "./persistence-orchestrator";
import { ProjectGitService } from "./project-git-service";
import {
  defineProjectState,
  defineProjectStatePersistence,
} from "./project-service";
import { readProjectSettingsForAll } from "./project-settings-file";
import {
  defineProjectTerminalsPersistence,
  defineProjectTerminalsState,
  ProjectTerminalsManager,
} from "./project-terminals";
import { SessionsServiceNew } from "./session-service";
import { SessionStateFileManager } from "./session-state-file-manager";
import { SessionTitleManager } from "./session-title-manager";
import { CodexSessionsManager } from "./sessions/codex.session";
import { CursorAgentSessionsManager } from "./sessions/cursor-agent.session";
import { LocalTerminalSessionsManager } from "./sessions/local-terminal.session";
import {
  defineSessionServiceState,
  defineSessionStatePersistence,
  removeLegacyLocalTerminalSessions,
} from "./sessions/state";
import { WorktreeSetupSessionsManager } from "./sessions/worktree-setup.session";
import { ensureShellIntegrationScripts } from "./shell-integration/scripts";
import { StateOrchestrator } from "./state-orchestrator";
import { TerminalManager } from "./terminal-manager";

const STORAGE_SCHEMA_VERSION = 3;

interface CreateServicesOptions {
  userDataPath: string;
  getMainWindow: () => Electron.BrowserWindow | null;
  disposeSignal: AbortSignal;
}

interface ShellIntegrationInitResult {
  shellIntegrationEnv: Record<string, string>;
}

interface ManagedPluginInitializationResult {
  managedPluginDir: string | null;
  pluginWarning: string | null;
}

interface ManagedCursorHooksInitializationResult {
  cursorConfigDir: string | null;
  cursorHooksWarning: string | null;
}

async function initializeShellIntegration(
  userDataPath: string,
): Promise<ShellIntegrationInitResult> {
  try {
    const scripts = await ensureShellIntegrationScripts(userDataPath);
    return { shellIntegrationEnv: scripts.env };
  } catch (error) {
    log.error("Shell integration setup failed", error);
    return { shellIntegrationEnv: {} };
  }
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

async function initializeManagedCursorHooks(
  userDataPath: string,
): Promise<ManagedCursorHooksInitializationResult> {
  try {
    const managedHooks = await ensureManagedCursorStateHooks(userDataPath);
    return {
      cursorConfigDir: managedHooks.configDir,
      cursorHooksWarning: null,
    };
  } catch (error) {
    return {
      cursorConfigDir: null,
      cursorHooksWarning:
        error instanceof Error
          ? `Cursor hook monitoring failed to initialize: ${error.message}`
          : "Cursor hook monitoring failed to initialize.",
    };
  }
}

export type CreateServicesResult = Awaited<ReturnType<typeof createServices>>;

export async function createServices(options: CreateServicesOptions) {
  const { userDataPath, getMainWindow, disposeSignal } = options;
  const [
    { managedPluginDir, pluginWarning },
    { cursorConfigDir, cursorHooksWarning },
    { shellIntegrationEnv },
  ] = await Promise.all([
    initializeManagedPlugin(userDataPath),
    initializeManagedCursorHooks(userDataPath),
    initializeShellIntegration(userDataPath),
  ]);

  const titleManager = new SessionTitleManager();
  const codexTitleManager = new SessionTitleManager({
    generateTitle: generateCodexSessionTitle,
  });

  const stateFileManager = new SessionStateFileManager(userDataPath);
  const cursorSessionLogFileManager = new CursorSessionLogFileManager(
    userDataPath,
  );

  const persistenceService = new PersistenceOrchestrator({
    schemaVersion: STORAGE_SCHEMA_VERSION,
  });

  const appSettingsState = defineAppSettingsState();
  persistenceService.registerAndHydrate(
    defineAppSettingsPersistence(appSettingsState),
  );

  const projectsState = defineProjectState();
  persistenceService.registerAndHydrate(
    defineProjectStatePersistence(projectsState),
  );

  const projectTerminalsState = defineProjectTerminalsState();
  persistenceService.registerAndHydrate(
    defineProjectTerminalsPersistence(projectTerminalsState),
  );

  // Hydrate project defaults from .agent-ui/settings.jsonc files
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

  const projectGitService = new ProjectGitService(projectsState);
  projectGitService.start();

  const sessionsState = defineSessionServiceState();
  persistenceService.registerAndHydrate(
    defineSessionStatePersistence(sessionsState),
  );
  removeLegacyLocalTerminalSessions(sessionsState);

  const sessionsService = new SessionsServiceNew({
    pluginDir: managedPluginDir,
    pluginWarning,
    terminalManager: new TerminalManager(),
    titleManager,
    stateFileManager,
    state: sessionsState,
  });
  const terminalManager = sessionsService.terminalManager;

  const localTerminalSessionsManager = new LocalTerminalSessionsManager(
    sessionsState,
    terminalManager,
  );
  const projectTerminalsManager = new ProjectTerminalsManager(
    projectTerminalsState,
    shellIntegrationEnv,
    terminalManager,
  );
  const codexSessionsManager = new CodexSessionsManager({
    state: sessionsState,
    terminalManager,
    titleManager: codexTitleManager,
  });
  const cursorAgentSessionsManager = new CursorAgentSessionsManager({
    state: sessionsState,
    terminalManager,
    cursorConfigDir,
    sessionLogFileManager: cursorSessionLogFileManager,
    cursorHooksWarning,
  });
  const worktreeSetupSessionsManager = new WorktreeSetupSessionsManager(
    sessionsState,
    disposeSignal,
  );
  const desktopIntegrationManager = new DesktopIntegrationManager(
    sessionsState,
    appSettingsState,
  );

  const stateService = new StateOrchestrator({
    serviceStates: {
      appSettings: appSettingsState,
      projects: projectsState,
      projectTerminals: projectTerminalsState,
      sessions: sessionsState,
    },
  });

  const shutdownDisposable = createDisposable({
    onError: (error) => {
      log.error("Error while shutting down services", error);
    },
  });

  shutdownDisposable.addDisposable(async () => await sessionsService.dispose());
  shutdownDisposable.addDisposable(async () => await terminalManager.dispose());
  shutdownDisposable.addDisposable(
    async () => await localTerminalSessionsManager.dispose(),
  );
  shutdownDisposable.addDisposable(
    async () => await projectTerminalsManager.dispose(),
  );
  shutdownDisposable.addDisposable(() => projectGitService.dispose());
  shutdownDisposable.addDisposable(
    async () => await codexSessionsManager.dispose(),
  );
  shutdownDisposable.addDisposable(
    async () => await cursorAgentSessionsManager.dispose(),
  );
  shutdownDisposable.addDisposable(
    async () => await worktreeSetupSessionsManager.dispose(),
  );
  shutdownDisposable.addDisposable(() => desktopIntegrationManager.dispose());
  shutdownDisposable.addDisposable(() => stateService.dispose());
  shutdownDisposable.addDisposable(() => persistenceService.dispose());

  return {
    appSettingsState,
    projectsState,
    projectTerminalsState,
    projectGitService,
    getMainWindow,
    sessionsService,
    terminalManager,
    projectTerminalsManager,
    stateService,
    shutdown: shutdownDisposable.dispose,
    managedPluginDir,
    pluginWarning,
    sessions: {
      state: sessionsState,
      localTerminal: localTerminalSessionsManager,
      codex: codexSessionsManager,
      cursorAgent: cursorAgentSessionsManager,
      worktreeSetup: worktreeSetupSessionsManager,
    },
  };
}

export type Services = Awaited<ReturnType<typeof createServices>>;

export type SyncState = Services["stateService"]["~stateMap"];
