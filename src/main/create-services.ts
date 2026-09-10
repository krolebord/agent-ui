import path from "node:path";
import type { CodexPermissionMode } from "@shared/codex-types";
import { createDisposable } from "@shared/utils";
import type { AppHost } from "./app-host";
import {
  defineAppSettingsPersistence,
  defineAppSettingsState,
} from "./app-settings";
import {
  ArtifactsService,
  defineArtifactsPersistence,
  defineArtifactsState,
} from "./artifacts-service";
import { ClaudeAccountLoginService } from "./claude-account-login";
import {
  ClaudeAccountsService,
  defineClaudeAccountsInternalState,
  defineClaudeAccountsPersistence,
  defineClaudeAccountsPublicState,
} from "./claude-accounts";
import type { ClaudeAccountAuth } from "./claude-cli";
import { ensureManagedClaudeStatePlugin } from "./claude-state-plugin";
import { CodexAccountLoginService } from "./codex-account-login";
import {
  CodexAccountsService,
  defineCodexAccountsInternalState,
  defineCodexAccountsPersistence,
  defineCodexAccountsPublicState,
} from "./codex-accounts";
import type { CursorAgentMode, CursorAgentPermissionMode } from "./cursor-cli";
import { CursorSessionLogFileManager } from "./cursor-session-log-file-manager";
import { ensureManagedCursorStateHooks } from "./cursor-state-hooks";
import { DatabaseService } from "./database/database-service";
import { SqliteSessionBufferStore } from "./database/session-buffer-store";
import {
  GlobalInstructionsService,
  SqliteGlobalInstructionsStore,
} from "./global-instructions-service";
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
import { getTextGenerationWorkingDirectory } from "./text-generation-workspace";
import { TitleGenerationService } from "./title-generation-service";
import { UsageHistoryService } from "./usage-history/service";
import {
  defineUsagePersistence,
  defineUsageState,
  UsageTracker,
} from "./usage-tracking";

const STORAGE_SCHEMA_VERSION = 3;

const SCHEDULED_SESSION_COLS = 120;
const SCHEDULED_SESSION_ROWS = 30;

const SPAWN_TOKEN_MIN_REMAINING_MS = 30 * 60_000;

interface CreateServicesOptions {
  host: AppHost;
  disposeSignal: AbortSignal;
  mcpSessionTokens?: McpSessionTokens;
  getMcpServerUrl?: (context: McpRequestContext) => string | null;
  getWebAppUrl?: () => string | null;
}

interface ShellIntegrationInitResult {
  shellIntegrationEnv: Record<string, string>;
}

interface ManagedPluginInitializationResult {
  managedPluginDir: string | null;
  pluginWarning: string | null;
}

interface ManagedCursorHooksInitializationResult {
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
    await ensureManagedCursorStateHooks(userDataPath);
    return {
      cursorHooksWarning: null,
    };
  } catch (error) {
    return {
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
  const getWebAppUrl = options.getWebAppUrl ?? (() => null);
  const mcpSessionTokens = options.mcpSessionTokens ?? new McpSessionTokens();
  const userDataPath = host.paths.userData;
  const [
    { managedPluginDir, pluginWarning },
    { cursorHooksWarning },
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

  const databaseService = await DatabaseService.create(userDataPath);
  const sessionBuffers = new SqliteSessionBufferStore(databaseService.db);
  const globalInstructionsService = new GlobalInstructionsService({
    store: new SqliteGlobalInstructionsStore(databaseService.db),
  });

  const persistenceService = new PersistenceOrchestrator({
    schemaVersion: STORAGE_SCHEMA_VERSION,
    store: createPersistenceStore(userDataPath),
  });

  const appSettingsState = defineAppSettingsState();
  persistenceService.registerAndHydrate(
    defineAppSettingsPersistence(appSettingsState),
  );

  const textGenerationWorkingDirectory =
    getTextGenerationWorkingDirectory(userDataPath);

  const claudeAccountsInternalState = defineClaudeAccountsInternalState();
  persistenceService.registerAndHydrate(
    defineClaudeAccountsPersistence(claudeAccountsInternalState),
  );
  const claudeAccountsPublicState = defineClaudeAccountsPublicState();
  const claudeAccountsService = new ClaudeAccountsService({
    internalState: claudeAccountsInternalState,
    publicState: claudeAccountsPublicState,
  });

  const getAccountAuth = async (
    accountId: string,
  ): Promise<ClaudeAccountAuth | null> => {
    const account = claudeAccountsService.getAccount(accountId);
    if (!account) {
      return null;
    }
    if (account.type === "setup-token") {
      return { type: "setup-token", token: account.token };
    }
    const token = await claudeAccountsService.getValidAccessToken(accountId, {
      minRemainingMs: SPAWN_TOKEN_MIN_REMAINING_MS,
    });
    return { type: "managed", token };
  };

  const codexAccountsInternalState = defineCodexAccountsInternalState();
  persistenceService.registerAndHydrate(
    defineCodexAccountsPersistence(codexAccountsInternalState),
  );
  const codexAccountsPublicState = defineCodexAccountsPublicState();
  const codexAccountsService = new CodexAccountsService({
    internalState: codexAccountsInternalState,
    publicState: codexAccountsPublicState,
  });

  const getCodexExternalAuth = async (accountId: string) =>
    await codexAccountsService.getExternalAuth(accountId);

  const titleGenerationService = new TitleGenerationService({
    getSettings: () => appSettingsState.state.titleGeneration,
    workingDirectory: textGenerationWorkingDirectory,
  });

  const projectsState = defineProjectState();
  persistenceService.registerAndHydrate(
    defineProjectStatePersistence(projectsState),
  );

  const artifactsState = defineArtifactsState();
  persistenceService.registerAndHydrate(
    defineArtifactsPersistence(artifactsState),
  );
  const artifactsService = new ArtifactsService(artifactsState);

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

  const droppedBuffers = await sessionBuffers.deleteOrphans(
    Object.keys(sessionsState.state),
  );
  if (droppedBuffers > 0) {
    log.info(`Dropped ${droppedBuffers} orphaned session buffers`);
  }

  const sessionsService = new SessionsServiceNew({
    pluginDir: managedPluginDir,
    pluginWarning,
    terminalManager: new TerminalManager(),
    titleGeneration: titleGenerationService,
    stateFileManager,
    state: sessionsState,
    getMcpServerUrl,
    getAccountAuth,
    sessionBuffers,
  });
  const terminalManager = sessionsService.terminalManager;

  const claudeAccountLogin = new ClaudeAccountLoginService({
    userDataPath,
    terminalManager,
    accounts: claudeAccountsService,
  });

  const codexAccountLogin = new CodexAccountLoginService({
    userDataPath,
    terminalManager,
    accounts: codexAccountsService,
  });

  const localTerminalSessionsManager = new LocalTerminalSessionsManager(
    sessionsState,
    terminalManager,
    sessionBuffers,
  );
  const projectTerminalsManager = new ProjectTerminalsManager(
    projectTerminalsState,
    shellIntegrationEnv,
    terminalManager,
    (cwd) =>
      projectsState.state.find((project) => project.path === cwd)
        ?.worktreeOriginPath,
  );
  const codexSessionsManager = new CodexSessionsManager({
    state: sessionsState,
    terminalManager,
    titleGeneration: titleGenerationService,
    getMcpServerUrl,
    sessionBuffers,
    getExternalAuth: getCodexExternalAuth,
  });
  const cursorAgentSessionsManager = new CursorAgentSessionsManager({
    state: sessionsState,
    terminalManager,
    titleGeneration: titleGenerationService,
    sessionLogFileManager: cursorSessionLogFileManager,
    cursorHooksWarning,
    sessionBuffers,
  });
  const worktreeSetupSessionsManager = new WorktreeSetupSessionsManager(
    sessionsState,
    disposeSignal,
  );

  const usageState = defineUsageState();
  persistenceService.registerAndHydrate(defineUsagePersistence(usageState));
  const usageTracker = new UsageTracker({
    state: usageState,
    claudeAccounts: claudeAccountsService,
    codexAccounts: codexAccountsService,
    codexSessions: codexSessionsManager,
  });
  usageTracker.start();

  const usageHistoryService = new UsageHistoryService({ userDataPath });

  const scheduledSessionsState = defineScheduledSessionsState();
  persistenceService.registerAndHydrate(
    defineScheduledSessionsPersistence(scheduledSessionsState),
  );
  const scheduledSessionsService = new ScheduledSessionsService({
    state: scheduledSessionsState,
    runSession: async (config, meta) => {
      await skillsService.ensureFreshForPath(config.cwd);
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
            accountId: input.accountId,
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
      claudeAccounts: claudeAccountsPublicState,
      codexAccounts: codexAccountsPublicState,
      projects: projectsState,
      projectTerminals: projectTerminalsState,
      sessions: sessionsState,
      handoffs: handoffsState,
      machineStats: machineStatsState,
      skills: skillsState,
      scheduledSessions: scheduledSessionsState,
      artifacts: artifactsState,
      usage: usageState,
    },
  });

  const shutdownDisposable = createDisposable({
    onError: (error) => {
      log.error("Error while shutting down services", error);
    },
  });

  shutdownDisposable.addDisposable(
    async () => await claudeAccountLogin.dispose(),
  );
  shutdownDisposable.addDisposable(
    async () => await codexAccountLogin.dispose(),
  );
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
  shutdownDisposable.addDisposable(() => usageTracker.dispose());
  shutdownDisposable.addDisposable(
    async () => await usageHistoryService.dispose(),
  );
  shutdownDisposable.addDisposable(() => handoffsService.dispose());
  shutdownDisposable.addDisposable(() => skillsService.dispose());
  shutdownDisposable.addDisposable(() => stateService.dispose());
  shutdownDisposable.addDisposable(() => persistenceService.dispose());

  const shutdown = async () => {
    await shutdownDisposable.dispose();
    await databaseService.close();
  };

  return {
    appSettingsState,
    artifactsService,
    claudeAccounts: claudeAccountsService,
    claudeAccountLogin,
    codexAccounts: codexAccountsService,
    codexAccountLogin,
    machineStatsState,
    usageState,
    usageTracker,
    usageHistory: usageHistoryService,
    projectsState,
    projectTerminalsState,
    projectGitService,
    host,
    sessionsService,
    terminalManager,
    projectTerminalsManager,
    stateService,
    databaseService,
    sessionBuffers,
    globalInstructionsService,
    textGenerationWorkingDirectory,
    shutdown,
    managedPluginDir,
    pluginWarning,
    handoffsService,
    skillsService,
    scheduledSessionsService,
    mcpSessionTokens,
    getWebAppUrl,
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
