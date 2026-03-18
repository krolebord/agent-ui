import z from "zod";
import {
  type ClaudeProject,
  claudeEffortSchema,
  claudeModelSchema,
  claudePermissionModeSchema,
} from "../shared/claude-types";
import {
  codexFastModeSchema,
  codexModelReasoningEffortSchema,
  codexPermissionModeSchema,
} from "../shared/codex-types";
import { defineServiceState } from "../shared/service-state";
import type { Services } from "./create-services";
import { procedure } from "./orpc";
import { defineStatePersistence } from "./persistence-orchestrator";
import { writeProjectSettingsFile } from "./project-settings-file";
import type { Session } from "./sessions/state";

const cursorAgentModeSchema = z.enum(["plan", "ask"]);
const cursorAgentPermissionModeSchema = z.enum(["default", "yolo"]);

const localClaudeProjectSettingsSchema = z.object({
  defaultModel: claudeModelSchema.optional().catch(undefined),
  defaultPermissionMode: claudePermissionModeSchema.optional().catch(undefined),
  defaultEffort: claudeEffortSchema.optional().catch(undefined),
  defaultHaikuModelOverride: claudeModelSchema.optional().catch(undefined),
  defaultSubagentModelOverride: claudeModelSchema.optional().catch(undefined),
  defaultSystemPrompt: z.string().optional().catch(undefined),
});

const localCodexProjectSettingsSchema = z.object({
  model: z.string().optional().catch(undefined),
  permissionMode: codexPermissionModeSchema.optional().catch(undefined),
  modelReasoningEffort: codexModelReasoningEffortSchema
    .optional()
    .catch(undefined),
  fastMode: codexFastModeSchema.optional().catch(undefined),
  configOverrides: z.string().optional().catch(undefined),
});

const localCursorProjectSettingsSchema = z.object({
  model: z.string().optional().catch(undefined),
  mode: cursorAgentModeSchema.optional().catch(undefined),
  permissionMode: cursorAgentPermissionModeSchema.optional().catch(undefined),
});

const projectAliasSchema = z.string().trim().optional().catch(undefined);
const worktreeOriginPathSchema = z
  .string()
  .trim()
  .min(1)
  .optional()
  .catch(undefined);

function toOptionalSettings<T extends Record<string, unknown>>(
  value: T | undefined,
): T | undefined {
  if (!value) {
    return undefined;
  }
  return Object.values(value).some((item) => item !== undefined)
    ? value
    : undefined;
}

export const claudeProjectSchema = z.object({
  path: z.string().trim().min(1),
  collapsed: z.boolean().catch(false),
  alias: projectAliasSchema,
  worktreeOriginPath: worktreeOriginPathSchema,
  localClaude: localClaudeProjectSettingsSchema.optional().catch(undefined),
  localCodex: localCodexProjectSettingsSchema.optional().catch(undefined),
  localCursor: localCursorProjectSettingsSchema.optional().catch(undefined),
});

function normalizeProjectPath(pathValue: string): string {
  return pathValue.trim();
}

function normalizeProjectAlias(
  aliasValue: string | undefined,
): string | undefined {
  const alias = aliasValue?.trim();
  return alias ? alias : undefined;
}

function normalizeProjects(projects: ClaudeProject[]): ClaudeProject[] {
  const seenPaths = new Set<string>();
  const normalized: ClaudeProject[] = [];

  for (const project of projects) {
    const path = normalizeProjectPath(project.path);
    if (!path || seenPaths.has(path)) {
      continue;
    }

    seenPaths.add(path);
    normalized.push({
      ...project,
      path,
      alias: normalizeProjectAlias(project.alias),
      collapsed: project.collapsed === true,
      worktreeOriginPath: project.worktreeOriginPath?.trim() || undefined,
    });
  }

  return normalized;
}

export const defineProjectState = () =>
  defineServiceState({
    key: "projects" as const,
    defaults: [] as ClaudeProject[],
  });

export type ProjectState = ReturnType<typeof defineProjectState>;

export const defineProjectStatePersistence = (state: ProjectState) =>
  defineStatePersistence({
    serviceState: state,
    schema: z.array(claudeProjectSchema).transform(normalizeProjects),
    toPersisted: (projects) =>
      projects.map(({ path, collapsed, alias, worktreeOriginPath }) => ({
        path,
        collapsed,
        alias,
        worktreeOriginPath,
      })) as ClaudeProject[],
  });

const projectPathSchema = z.string().trim().min(1);
const gitBranchSchema = z.string().trim().min(1);

async function deleteProjectSessionsForPath(
  sessionsById: Record<string, Session>,
  projectPath: string,
  context: Services,
): Promise<void> {
  const sessionIds = Object.entries(sessionsById)
    .filter(([, session]) => session.startupConfig.cwd === projectPath)
    .map(([sessionId]) => sessionId);

  for (const sessionId of sessionIds) {
    const session = context.sessions.state.state[sessionId];
    if (!session) {
      continue;
    }

    switch (session.type) {
      case "claude-local-terminal":
        await context.sessionsService.deleteSession(sessionId);
        break;
      case "local-terminal":
        await context.sessions.localTerminal.deleteSession(sessionId);
        break;
      case "ralph-loop":
        await context.sessions.ralphLoop.deleteSession(sessionId);
        break;
      case "codex-local-terminal":
        await context.sessions.codex.deleteSession(sessionId);
        break;
      case "cursor-agent":
        await context.sessions.cursorAgent.deleteSession(sessionId);
        break;
    }
  }
}

async function removeTrackedProject(
  path: string,
  context: Services,
): Promise<void> {
  await deleteProjectSessionsForPath(
    context.sessions.state.state,
    path,
    context,
  );
  await context.projectTerminalsManager.deleteWorkspace(path);

  context.projectsState.updateState((projects) => {
    const idx = projects.findIndex((p) => p.path === path);
    if (idx === -1) return;
    projects.splice(idx, 1);
  });
}

export const projectsRouter = {
  addProject: procedure
    .input(z.object({ path: projectPathSchema }))
    .handler(async ({ input, context }) => {
      const path = normalizeProjectPath(input.path);
      if (!path || context.projectsState.state.some((p) => p.path === path))
        return { path };

      context.projectsState.updateState((projects) => {
        projects.push({ path, collapsed: false });
      });
      await context.projectGitService.refreshProject(path);
      return { path };
    }),
  getWorktreeCreationData: procedure
    .input(z.object({ path: projectPathSchema }))
    .handler(async ({ input, context }) => {
      return context.projectGitService.getWorktreeCreationData(
        normalizeProjectPath(input.path),
      );
    }),
  createWorktreeProject: procedure
    .input(
      z.object({
        sourcePath: projectPathSchema,
        fromBranch: gitBranchSchema,
        newBranch: gitBranchSchema,
        destinationPath: projectPathSchema,
        alias: projectAliasSchema,
      }),
    )
    .handler(async ({ input, context }) => {
      return context.projectGitService.createWorktreeProject({
        sourcePath: normalizeProjectPath(input.sourcePath),
        fromBranch: input.fromBranch.trim(),
        newBranch: input.newBranch.trim(),
        destinationPath: normalizeProjectPath(input.destinationPath),
        alias: normalizeProjectAlias(input.alias),
      });
    }),
  setProjectCollapsed: procedure
    .input(z.object({ path: projectPathSchema, collapsed: z.boolean() }))
    .handler(async ({ input, context }) => {
      const path = normalizeProjectPath(input.path);
      if (!path) return;

      context.projectsState.updateState((projects) => {
        const project = projects.find((p) => p.path === path);
        if (!project || project.collapsed === input.collapsed) return;
        project.collapsed = input.collapsed;
      });
    }),
  setProjectDefaults: procedure
    .input(
      z.object({
        path: projectPathSchema,
        localClaude: localClaudeProjectSettingsSchema.optional(),
        localCodex: localCodexProjectSettingsSchema.optional(),
        localCursor: localCursorProjectSettingsSchema.optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const path = normalizeProjectPath(input.path);
      if (!path) return;

      const settings = {
        localClaude: toOptionalSettings(input.localClaude),
        localCodex: toOptionalSettings(input.localCodex),
        localCursor: toOptionalSettings(input.localCursor),
      };

      context.projectsState.updateState((projects) => {
        const project = projects.find((p) => p.path === path);
        if (!project) return;
        project.localClaude = settings.localClaude;
        project.localCodex = settings.localCodex;
        project.localCursor = settings.localCursor;
      });

      await writeProjectSettingsFile(path, settings);
    }),
  deleteProject: procedure
    .input(z.object({ path: z.string().trim().min(1) }))
    .handler(async ({ input, context }) => {
      const path = normalizeProjectPath(input.path);
      if (!path) return;

      await removeTrackedProject(path, context);
    }),
  deleteWorktreeProject: procedure
    .input(
      z.object({
        path: projectPathSchema,
        deleteFolder: z.boolean(),
        deleteBranch: z.boolean(),
      }),
    )
    .handler(async ({ input, context }) => {
      const path = normalizeProjectPath(input.path);
      if (!path) {
        return {};
      }

      const result = await context.projectGitService.deleteWorktreeProject({
        path,
        deleteFolder: input.deleteFolder,
        deleteBranch: input.deleteBranch,
      });

      await removeTrackedProject(path, context);

      return result;
    }),
  reorderProjects: procedure
    .input(z.object({ fromPath: projectPathSchema, toPath: projectPathSchema }))
    .handler(async ({ input, context }) => {
      context.projectsState.updateState((projects) => {
        const fromIdx = projects.findIndex((p) => p.path === input.fromPath);
        const toIdx = projects.findIndex((p) => p.path === input.toPath);
        if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
        const [item] = projects.splice(fromIdx, 1);
        projects.splice(toIdx, 0, item);
      });
    }),
};
