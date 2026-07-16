import path from "node:path";
import type { CodexPermissionMode } from "@shared/codex-types";
import { createDisposable } from "@shared/utils";
import type { AppHost } from "./app-host";
import {
  defineAppSettingsPersistence,
  defineAppSettingsState,
} from "./app-settings";
import {
  defineClaudeAccountsPersistence,
  defineClaudeAccountsState,
  getClaudeAccountToken,
} from "./claude-accounts";
import { ensureManagedClaudeStatePlugin } from "./claude-state-plugin";
import type { CursorAgentMode, CursorAgentPermissionMode } from "./cursor-cli";
import { CursorSessionLogFileManager } from "./cursor-session-log-file-manager";
import { ensureManagedCursorStateHooks } from "./cursor-state-hooks";
import { defineHandoffsState, HandoffsService } from "./handoffs-service";
import log from "./logger";
import { defineMachineStatsState, MachineStatsMonitor } from "./machine-stats";
import { ensureManagedSkills } from "./managed-skills";
import { type McpRequestContext, McpSessionTokens } from "./mcp/session-token";
import {
  createPersistenceStore,
  PersistenceOrchestrator,
} from "./persistence-orchestrator";
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
import { ScheduledSessionsService } from "./scheduled-sessions/scheduler";
import {
  defineScheduledSessionsPersistence,
  defineScheduledSessionsState,
} from "./scheduled-sessions/state";
import { SessionsServiceNew } from "./session-service";
import { SessionStateFileManager } from "./session-state-file-manager";
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
import { defineSkillsState, SkillsService } from "./skills-service";
import { StateOrchestrator } from "./state-orchestrator";
import { TerminalManager } from "./terminal-manager";
import { TitleGenerationService } from "./title-generation-service";

const STORAGE_SCHEMA_VERSION = 3;

// Sessions started by the scheduler have no attached renderer yet; the
// terminal is resized to the real viewport once a client attaches.
const SCHEDULED_SESSION_COLS = 120;
const SCHEDULED_SESSION_ROWS = 30;

interface CreateServicesOptions {
  host: AppHost;
  disposeSignal: AbortSignal;
  mcpSessionTokens?: McpSessionTokens;
  getMcpServerUrl?: (context: McpRequestContext) => string | null;
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
  const { host, disposeSignal, getMcpServerUrl } = options;
  const mcpSessionTokens = options.mcpSessionTokens ?? new McpSessionTokens();
  const userDataPath = host.paths.userData;
  const [
    { managedPluginDir, pluginWarning },
    { cursorConfigDir, cursorHooksWarning },
    { shellIntegrationEnv },
  ] = await Promise.all([
    initializeManagedPlugin(userDataPath),
    initializeManagedCursorHooks(userDataPath),
    initializeShellIntegration(userDataPath),
  ]);

  let handoffsDir = path.join(userDataPath, "handoffs");
  let managedSkillsRoot: string | null = null;
  try {
    const result = await ensureManagedSkills(userDataPath, managedPluginDir);
    handoffsDir = result.handoffsDir;
    managedSkillsRoot = result.managedSkillsRoot;
  } catch (error) {
    log.error("Managed skills setup failed", error);
  }

  const handoffsState = defineHandoffsState();
  const handoffsService = new HandoffsService(handoffsDir, handoffsState);
  await handoffsService.start();

  const stateFileManager = new SessionStateFileManager(userDataPath);
  const cursorSessionLogFileManager = new CursorSessionLogFileManager(
    userDataPath,
  );

  const persistenceService = new PersistenceOrchestrator({
    schemaVersion: STORAGE_SCHEMA_VERSION,
    store: createPersistenceStore(userDataPath),
  });

  const appSettingsState = defineAppSettingsState();
  persistenceService.registerAndHydrate(
    defineAppSettingsPersistence(appSettingsState),
  );

  const claudeAccountsState = defineClaudeAccountsState();
  persistenceService.registerAndHydrate(
    defineClaudeAccountsPersistence(claudeAccountsState),
  );

  const titleGenerationService = new TitleGenerationService({
    getSettings: () => appSettingsState.state.titleGeneration,
  });

  const projectsState = defineProjectState();
  persistenceService.registerAndHydrate(
    defineProjectStatePersistence(projectsState),
  );

  const projectTerminalsState = defineProjectTerminalsState();
  persistenceService.registerAndHydrate(
    defineProjectTerminalsPersistence(projectTerminalsState),
  );

  const machineStatsState = defineMachineStatsState();
  const machineStatsMonitor = new MachineStatsMonitor(
    machineStatsState,
    appSettingsState,
  );
  machineStatsMonitor.start();

  // Hydrate worktree setup commands from .agent-ui/settings.jsonc files
  const projectPaths = projectsState.state.map((p) => p.path);
  if (projectPaths.length > 0) {
    const fileSettings = await readProjectSettingsForAll(projectPaths);
    if (fileSettings.size > 0) {
      projectsState.updateState((projects) => {
        for (const project of projects) {
          const settings = fileSettings.get(project.path);
          if (!settings?.worktreeSetupCommands) continue;
          project.worktreeSetupCommands = settings.worktreeSetupCommands;
        }
      });
    }
  }

  const projectGitService = new ProjectGitService(projectsState);
  projectGitService.start();

  const skillsState = defineSkillsState();
  const skillsService = new SkillsService({
    state: skillsState,
    projectsState,
    builtinSkillsRoot: managedSkillsRoot,
  });
  await skillsService.start();

  const sessionsState = defineSessionServiceState();
  persistenceService.registerAndHydrate(
    defineSessionStatePersistence(sessionsState),
  );
  removeLegacyLocalTerminalSessions(sessionsState);

  const sessionsService = new SessionsServiceNew({
    pluginDir: managedPluginDir,
    pluginWarning,
    terminalManager: new TerminalManager(),
    titleGeneration: titleGenerationService,
    stateFileManager,
    state: sessionsState,
    getMcpServerUrl,
    getAccountToken: (accountId) =>
      getClaudeAccountToken(claudeAccountsState, accountId),
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
    titleGeneration: titleGenerationService,
    getMcpServerUrl,
  });
  const cursorAgentSessionsManager = new CursorAgentSessionsManager({
    state: sessionsState,
    terminalManager,
    titleGeneration: titleGenerationService,
    cursorConfigDir,
    sessionLogFileManager: cursorSessionLogFileManager,
    cursorHooksWarning,
  });
  const worktreeSetupSessionsManager = new WorktreeSetupSessionsManager(
    sessionsState,
    disposeSignal,
  );

  const scheduledSessionsState = defineScheduledSessionsState();
  persistenceService.registerAndHydrate(
    defineScheduledSessionsPersistence(scheduledSessionsState),
  );
  const scheduledSessionsService = new ScheduledSessionsService({
    state: scheduledSessionsState,
    runSession: async (config, meta) => {
      await skillsService.ensureFreshForPath(config.cwd);
      // Sessions spawned from agent-created schedules must not be able to
      // schedule further sessions, or agents could chain spawns unattended.
      const mcpCanScheduleSessions = meta.createdBy !== "agent";
      switch (config.type) {
        case "claude": {
          const { type: _type, ...input } = config;
          return await sessionsService.startNewSession({
            ...input,
            mcpCanScheduleSessions,
            cols: SCHEDULED_SESSION_COLS,
            rows: SCHEDULED_SESSION_ROWS,
          });
        }
        case "codex": {
          const { type: _type, ...input } = config;
          const sessionId = codexSessionsManager.createSession({
            ...input,
            mcpCanScheduleSessions,
          });
          await codexSessionsManager.startLiveSession({
            sessionId,
            cwd: input.cwd,
            model: input.model,
            modelReasoningEffort: input.modelReasoningEffort,
            fastMode: input.fastMode,
            permissionMode: input.permissionMode as CodexPermissionMode,
            initialPrompt: input.initialPrompt,
            configOverrides: input.configOverrides,
            mcpEnabled: input.mcpEnabled,
            mcpCanScheduleSessions,
            cols: SCHEDULED_SESSION_COLS,
            rows: SCHEDULED_SESSION_ROWS,
          });
          return sessionId;
        }
        case "cursorAgent": {
          const { type: _type, ...input } = config;
          const sessionId =
            await cursorAgentSessionsManager.createSession(input);

          let plan = false;
          let initialPrompt = input.initialPrompt;
          if (initialPrompt?.startsWith("/plan")) {
            plan = true;
            initialPrompt =
              initialPrompt.slice("/plan".length).trim() || undefined;
          }

          await cursorAgentSessionsManager.startLiveSession({
            sessionId,
            cwd: input.cwd,
            model: input.model,
            mode: input.mode as CursorAgentMode | undefined,
            permissionMode: input.permissionMode as CursorAgentPermissionMode,
            initialPrompt,
            plan,
            cols: SCHEDULED_SESSION_COLS,
            rows: SCHEDULED_SESSION_ROWS,
          });
          return sessionId;
        }
      }
    },
  });
  scheduledSessionsService.start();

  const stateService = new StateOrchestrator({
    serviceStates: {
      appSettings: appSettingsState,
      claudeAccounts: claudeAccountsState,
      projects: projectsState,
      projectTerminals: projectTerminalsState,
      sessions: sessionsState,
      handoffs: handoffsState,
      machineStats: machineStatsState,
      skills: skillsState,
      scheduledSessions: scheduledSessionsState,
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
  shutdownDisposable.addDisposable(() => scheduledSessionsService.dispose());
  shutdownDisposable.addDisposable(() => machineStatsMonitor.dispose());
  shutdownDisposable.addDisposable(() => handoffsService.dispose());
  shutdownDisposable.addDisposable(() => skillsService.dispose());
  shutdownDisposable.addDisposable(() => stateService.dispose());
  shutdownDisposable.addDisposable(() => persistenceService.dispose());

  return {
    appSettingsState,
    claudeAccountsState,
    machineStatsState,
    projectsState,
    projectTerminalsState,
    projectGitService,
    host,
    sessionsService,
    terminalManager,
    projectTerminalsManager,
    stateService,
    shutdown: shutdownDisposable.dispose,
    managedPluginDir,
    pluginWarning,
    handoffsService,
    skillsService,
    scheduledSessionsService,
    mcpSessionTokens,
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
