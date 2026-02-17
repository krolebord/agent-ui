import z from "zod";
import {
  type ClaudeProject,
  claudeEffortSchema,
  claudeModelSchema,
  claudePermissionModeSchema,
} from "../shared/claude-types";
import { defineServiceState } from "../shared/service-state";
import { procedure } from "./orpc";
import { defineStatePersistence } from "./persistence-orchestrator";
import { writeProjectSettingsFile } from "./project-settings-file";

export const claudeProjectSchema = z.object({
  path: z.string().trim().min(1),
  collapsed: z.boolean().catch(false),
  defaultModel: claudeModelSchema.optional().catch(undefined),
  defaultPermissionMode: claudePermissionModeSchema.optional().catch(undefined),
  defaultEffort: claudeEffortSchema.optional().catch(undefined),
  defaultHaikuModelOverride: claudeModelSchema.optional().catch(undefined),
  defaultSubagentModelOverride: claudeModelSchema.optional().catch(undefined),
  defaultSystemPrompt: z.string().optional().catch(undefined),
});

function normalizeProjectPath(pathValue: string): string {
  return pathValue.trim();
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
      collapsed: project.collapsed === true,
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
      projects.map(({ path, collapsed }) => ({
        path,
        collapsed,
      })) as ClaudeProject[],
  });

const projectPathSchema = z.string().trim().min(1);

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
      return { path };
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
        defaultModel: claudeModelSchema.optional(),
        defaultPermissionMode: claudePermissionModeSchema.optional(),
        defaultEffort: claudeEffortSchema.optional(),
        defaultHaikuModelOverride: claudeModelSchema.optional(),
        defaultSubagentModelOverride: claudeModelSchema.optional(),
        defaultSystemPrompt: z.string().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const path = normalizeProjectPath(input.path);
      if (!path) return;

      const settings = {
        defaultModel: input.defaultModel,
        defaultPermissionMode: input.defaultPermissionMode,
        defaultEffort: input.defaultEffort,
        defaultHaikuModelOverride: input.defaultHaikuModelOverride,
        defaultSubagentModelOverride: input.defaultSubagentModelOverride,
        defaultSystemPrompt: input.defaultSystemPrompt,
      };

      context.projectsState.updateState((projects) => {
        const project = projects.find((p) => p.path === path);
        if (!project) return;
        Object.assign(project, settings);
      });

      await writeProjectSettingsFile(path, settings);
    }),
  deleteProject: procedure
    .input(z.object({ path: z.string().trim().min(1) }))
    .handler(async ({ input, context }) => {
      const path = normalizeProjectPath(input.path);
      if (!path) return;

      context.projectsState.updateState((projects) => {
        const idx = projects.findIndex((p) => p.path === path);
        if (idx === -1) return;
        projects.splice(idx, 1);
      });
    }),
};
