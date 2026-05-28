import { ORPCError } from "@orpc/server";
import { type FileDiffMetadata, parsePatchFiles } from "@pierre/diffs";
import z from "zod";
import type { ClaudeProject } from "../shared/claude-types";
import {
  autogenerateCommitPlaceholderSubject,
  type CommitProgressEvent,
  formatCommittedWithPlaceholderNote,
} from "../shared/commit-message-generation";
import { defineServiceState } from "../shared/service-state";
import { generateCommitMessage } from "./commit-message-generation";
import type { Services } from "./create-services";
import log from "./logger";
import { procedure } from "./orpc";
import { defineStatePersistence } from "./persistence-orchestrator";
import {
  type ProjectSettingsFile,
  readProjectSettingsFile,
  writeProjectSettingsFile,
} from "./project-settings-file";
import type { Session } from "./sessions/state";

const projectAliasSchema = z.string().trim().optional().catch(undefined);
const worktreeOriginPathSchema = z
  .string()
  .trim()
  .min(1)
  .optional()
  .catch(undefined);

const projectDeletionToastSchema = z.object({
  kind: z.enum(["warning", "error"]),
  message: z.string(),
});

export const claudeProjectSchema = z.object({
  path: z.string().trim().min(1),
  collapsed: z.boolean().catch(false),
  alias: projectAliasSchema,
  worktreeOriginPath: worktreeOriginPathSchema,
  worktreeSetupCommands: z.string().optional().catch(undefined),
  interactionDisabled: z.boolean().optional().catch(undefined),
  deletionToast: projectDeletionToastSchema.optional().catch(undefined),
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

async function readHydratedProjectSettings(
  projectPath: string,
): Promise<ProjectSettingsFile> {
  return (await readProjectSettingsFile(projectPath)) ?? {};
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
      case "codex-local-terminal":
        await context.sessions.codex.deleteSession(sessionId);
        break;
      case "cursor-agent":
        await context.sessions.cursorAgent.deleteSession(sessionId);
        break;
      case "worktree-setup":
        await context.sessions.worktreeSetup.deleteSession(sessionId);
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

export function assertProjectPathInteractionAllowed(
  path: string | undefined | null,
  context: Pick<Services, "projectsState">,
): void {
  const normalized = path?.trim();
  if (!normalized) {
    return;
  }
  const project = context.projectsState.state.find(
    (p) => p.path === normalized,
  );
  if (project?.interactionDisabled) {
    throw new Error("This project is busy. Try again in a moment.");
  }
}

async function runWorktreeDeletionJob(
  context: Services,
  input: {
    path: string;
    deleteBranch: boolean;
    forceDeleteFolder: boolean;
  },
): Promise<void> {
  const { path } = input;
  try {
    const result =
      await context.projectGitService.performDeleteWorktreeFolderAndBranch({
        path,
        deleteFolder: true,
        deleteBranch: input.deleteBranch,
        forceDeleteFolder: input.forceDeleteFolder,
      });

    const branchWarning = result.warning;
    if (branchWarning) {
      context.projectsState.updateState((projects) => {
        const p = projects.find((x) => x.path === path);
        if (p) {
          p.deletionToast = { kind: "warning", message: branchWarning };
        }
      });
    }

    await removeTrackedProject(path, context);
  } catch (error) {
    log.error("Background worktree deletion failed", error);
    const message =
      error instanceof Error && error.message.trim()
        ? error.message
        : "Worktree deletion failed.";
    context.projectsState.updateState((projects) => {
      const p = projects.find((x) => x.path === path);
      if (p) {
        p.interactionDisabled = false;
        p.deletionToast = { kind: "error", message };
      }
    });
  }
}

export async function addTrackedProject(
  path: string,
  context: {
    projectsState: ProjectState;
    projectGitService: {
      refreshProject(projectPath: string): Promise<void>;
    };
  },
): Promise<{ path: string }> {
  const normalizedPath = normalizeProjectPath(path);
  if (
    !normalizedPath ||
    context.projectsState.state.some(
      (project) => project.path === normalizedPath,
    )
  ) {
    return { path: normalizedPath };
  }

  context.projectsState.updateState((projects) => {
    if (projects.some((project) => project.path === normalizedPath)) {
      return;
    }

    projects.push({
      path: normalizedPath,
      collapsed: false,
    });
  });

  const hydratedSettings = await readHydratedProjectSettings(normalizedPath);

  context.projectsState.updateState((projects) => {
    const project = projects.find((item) => item.path === normalizedPath);
    if (!project) {
      return;
    }

    if (hydratedSettings.worktreeSetupCommands) {
      project.worktreeSetupCommands = hydratedSettings.worktreeSetupCommands;
    }
  });

  await context.projectGitService.refreshProject(normalizedPath);

  return { path: normalizedPath };
}

export async function refreshTrackedProject(
  path: string,
  context: {
    projectGitService: {
      refreshProject(projectPath: string): Promise<void>;
    };
  },
): Promise<{ path: string }> {
  const normalizedPath = normalizeProjectPath(path);
  if (!normalizedPath) {
    return { path: normalizedPath };
  }

  await context.projectGitService.refreshProject(normalizedPath);
  return { path: normalizedPath };
}

export const projectsRouter = {
  addProject: procedure
    .input(z.object({ path: projectPathSchema }))
    .handler(async ({ input, context }) =>
      addTrackedProject(input.path, context),
    ),
  getWorktreeCreationData: procedure
    .input(z.object({ path: projectPathSchema }))
    .handler(async ({ input, context }) => {
      return context.projectGitService.getWorktreeCreationData(
        normalizeProjectPath(input.path),
      );
    }),
  refreshProject: procedure
    .input(z.object({ path: projectPathSchema }))
    .handler(async ({ input, context }) => {
      assertProjectPathInteractionAllowed(input.path, context);
      return refreshTrackedProject(input.path, context);
    }),
  getUncommittedDiff: procedure
    .input(z.object({ path: projectPathSchema }))
    .handler(async ({ input, context }) => {
      const diff = await context.projectGitService.getUncommittedDiff(
        normalizeProjectPath(input.path),
      );
      if (!diff) return [] as FileDiffMetadata[];
      const files = parsePatchFiles(diff).flatMap((p) => p.files);
      return files;
    }),
  commitSelectedChanges: procedure
    .input(
      z.object({
        path: projectPathSchema,
        filePaths: z.array(z.string().trim().min(1)).min(1),
        subject: z.string().trim().optional(),
        description: z.string().trim().optional(),
      }),
    )
    .handler(async function* ({ input, context }) {
      const path = normalizeProjectPath(input.path);
      assertProjectPathInteractionAllowed(path, context);

      const subject = input.subject?.trim() ?? "";
      const description = input.description?.trim();

      yield { stage: "committing" } satisfies CommitProgressEvent;

      if (!subject) {
        try {
          await context.projectGitService.commitSelectedChanges(path, {
            paths: input.filePaths,
            subject: autogenerateCommitPlaceholderSubject,
          });
        } catch (error) {
          const message =
            error instanceof Error && error.message.trim()
              ? error.message
              : "Git commit failed.";
          throw new ORPCError("BAD_REQUEST", { message });
        }

        yield { stage: "committed" } satisfies CommitProgressEvent;

        const placeholderNote = formatCommittedWithPlaceholderNote();

        yield { stage: "generating" } satisfies CommitProgressEvent;

        try {
          const diff = await context.projectGitService.getLastCommitDiff(
            path,
            input.filePaths,
          );
          if (!diff) {
            throw new ORPCError("BAD_REQUEST", {
              message: `Failed to generate commit message. ${placeholderNote}`,
            });
          }

          const generated = await generateCommitMessage(
            context.appSettingsState.state.titleGeneration,
            diff,
          );
          if (!generated?.subject.trim()) {
            throw new ORPCError("BAD_REQUEST", {
              message: `Failed to generate commit message. ${placeholderNote}`,
            });
          }

          const finalSubject = generated.subject.trim();
          const finalDescription = description ?? generated.description?.trim();

          try {
            await context.projectGitService.amendLastCommitMessage(path, {
              subject: finalSubject,
              description: finalDescription,
            });
          } catch (error) {
            const detail =
              error instanceof Error && error.message.trim()
                ? error.message
                : "Failed to update commit message.";
            throw new ORPCError("BAD_REQUEST", {
              message: `${detail} ${placeholderNote}`,
            });
          }
        } catch (error) {
          if (error instanceof ORPCError) {
            throw error;
          }
          const detail =
            error instanceof Error && error.message.trim()
              ? error.message
              : "Failed to generate commit message.";
          throw new ORPCError("BAD_REQUEST", {
            message: `${detail} ${placeholderNote}`,
          });
        }

        yield { stage: "done" } satisfies CommitProgressEvent;
        return;
      }

      try {
        await context.projectGitService.commitSelectedChanges(path, {
          paths: input.filePaths,
          subject,
          description,
        });
      } catch (error) {
        const message =
          error instanceof Error && error.message.trim()
            ? error.message
            : "Git commit failed.";
        throw new ORPCError("BAD_REQUEST", { message });
      }

      yield { stage: "committed" } satisfies CommitProgressEvent;
      yield { stage: "done" } satisfies CommitProgressEvent;
    }),
  discardChanges: procedure
    .input(
      z.object({
        path: projectPathSchema,
        filePaths: z.array(z.string().trim().min(1)).min(1),
      }),
    )
    .handler(async ({ input, context }) => {
      const path = normalizeProjectPath(input.path);
      assertProjectPathInteractionAllowed(path, context);
      await context.projectGitService.discardChanges(path, input.filePaths);
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
      assertProjectPathInteractionAllowed(input.sourcePath, context);
      const result = await context.projectGitService.createWorktreeProject({
        sourcePath: normalizeProjectPath(input.sourcePath),
        fromBranch: input.fromBranch.trim(),
        newBranch: input.newBranch.trim(),
        destinationPath: normalizeProjectPath(input.destinationPath),
        alias: normalizeProjectAlias(input.alias),
      });

      let sessionId: string | undefined;
      if (result.setupCommands.length > 0) {
        sessionId = context.sessions.worktreeSetup.createSessionAndStart({
          cwd: result.worktreeRoot,
          projectRoot: result.projectRoot,
          commands: result.setupCommands,
        });
      }

      return { path: result.path, sessionId };
    }),
  setProjectCollapsed: procedure
    .input(z.object({ path: projectPathSchema, collapsed: z.boolean() }))
    .handler(async ({ input, context }) => {
      const path = normalizeProjectPath(input.path);
      if (!path) return;

      assertProjectPathInteractionAllowed(path, context);

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
        worktreeSetupCommands: z.string().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const path = normalizeProjectPath(input.path);
      if (!path) return;

      assertProjectPathInteractionAllowed(path, context);

      const worktreeSetupCommands = input.worktreeSetupCommands || undefined;

      context.projectsState.updateState((projects) => {
        const project = projects.find((p) => p.path === path);
        if (!project) return;
        project.worktreeSetupCommands = worktreeSetupCommands;
      });

      await writeProjectSettingsFile(path, { worktreeSetupCommands });
    }),
  deleteProject: procedure
    .input(z.object({ path: z.string().trim().min(1) }))
    .handler(async ({ input, context }) => {
      const path = normalizeProjectPath(input.path);
      if (!path) return;

      assertProjectPathInteractionAllowed(path, context);

      await removeTrackedProject(path, context);
    }),
  ackDeletionToast: procedure
    .input(z.object({ path: projectPathSchema }))
    .handler(async ({ input, context }) => {
      const path = normalizeProjectPath(input.path);
      if (!path) return;

      context.projectsState.updateState((projects) => {
        const project = projects.find((p) => p.path === path);
        if (!project) return;
        project.deletionToast = undefined;
      });
    }),
  deleteWorktreeProject: procedure
    .input(
      z.object({
        path: projectPathSchema,
        deleteFolder: z.boolean(),
        deleteBranch: z.boolean(),
        forceDeleteFolder: z.boolean(),
      }),
    )
    .handler(async ({ input, context }) => {
      const path = normalizeProjectPath(input.path);
      if (!path) {
        return {};
      }

      const project = context.projectsState.state.find((p) => p.path === path);
      if (project?.interactionDisabled) {
        throw new Error(
          "Worktree removal is already in progress for this project.",
        );
      }

      if (!input.deleteFolder) {
        await context.projectGitService.deleteWorktreeProject({
          path,
          deleteFolder: false,
          deleteBranch: input.deleteBranch,
          forceDeleteFolder: false,
        });
        await removeTrackedProject(path, context);
        return {};
      }

      const preflight =
        await context.projectGitService.preflightDeleteWorktreeFolder({
          path,
          deleteFolder: true,
          deleteBranch: input.deleteBranch,
          forceDeleteFolder: input.forceDeleteFolder,
        });

      if (preflight?.requiresForce) {
        return preflight;
      }

      context.projectsState.updateState((projects) => {
        const p = projects.find((x) => x.path === path);
        if (p) {
          p.interactionDisabled = true;
        }
      });

      void runWorktreeDeletionJob(context, {
        path,
        deleteBranch: input.deleteBranch,
        forceDeleteFolder: input.forceDeleteFolder,
      }).catch((error) => {
        log.error("Worktree deletion job rejected", error);
      });

      return { accepted: true as const };
    }),
  reorderProjects: procedure
    .input(z.object({ fromPath: projectPathSchema, toPath: projectPathSchema }))
    .handler(async ({ input, context }) => {
      assertProjectPathInteractionAllowed(input.fromPath, context);
      assertProjectPathInteractionAllowed(input.toPath, context);

      context.projectsState.updateState((projects) => {
        const fromIdx = projects.findIndex((p) => p.path === input.fromPath);
        const toIdx = projects.findIndex((p) => p.path === input.toPath);
        if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
        const [item] = projects.splice(fromIdx, 1);
        projects.splice(toIdx, 0, item);
      });
    }),
};
