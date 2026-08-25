import { ORPCError } from "@orpc/server";
import {
  type FileContents,
  type FileDiffMetadata,
  parseDiffFromFile,
  parsePatchFiles,
} from "@pierre/diffs";
import z from "zod";
import type { ClaudeProject } from "../shared/claude-types";
import {
  autogenerateCommitPlaceholderSubject,
  type CommitProgressEvent,
  formatCommittedWithPlaceholderNote,
  type GeneratedCommitMessage,
} from "../shared/commit-message-generation";
import {
  PROJECT_COMMANDS_LIMIT,
  projectCommandWriteSchema,
} from "../shared/project-commands";
import { defineServiceState } from "../shared/service-state";
import type { TitleGenerationSettings } from "../shared/title-generation";
import { generateCommitMessage } from "./commit-message-generation";
import type { Services } from "./create-services";
import log from "./logger";
import { procedure } from "./orpc";
import { readProjectScripts } from "./package-scripts";
import { defineStatePersistence } from "./persistence-orchestrator";
import {
  getProjectFaviconDataUrl,
  invalidateProjectFavicon,
} from "./project-favicon";
import {
  EditableFileConflictError,
  readEditableFileSnapshot,
  readGitFileContents,
  saveEditableFileSnapshot,
  UnsupportedEditableFileError,
} from "./project-file-edit";
import type { PullFromRemoteResult } from "./project-git-service";
import {
  type ProjectSettingsFile,
  readProjectCommands,
  readProjectSettingsFile,
  writeProjectCommands,
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
  hidden: z.boolean().optional().catch(undefined),
  alias: projectAliasSchema,
  worktreeOriginPath: worktreeOriginPathSchema,
  worktreeSetupCommands: z.string().optional().catch(undefined),
  interactionDisabled: z.boolean().optional().catch(undefined),
  deletionToast: projectDeletionToastSchema.optional().catch(undefined),
});

function normalizeProjectPath(pathValue: string): string {
  return pathValue.trim();
}

const projectCommitLocks = new Map<string, Promise<void>>();

/**
 * Serializes commit pipelines per project. The auto-message flow amends HEAD
 * after generation, so a second commit landing in between would get its
 * message overwritten by the first commit's generated one (and concurrent
 * `git commit` calls can collide on index.lock).
 */
export async function acquireProjectCommitLock(
  projectPath: string,
): Promise<() => void> {
  const previous = projectCommitLocks.get(projectPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  projectCommitLocks.set(projectPath, tail);
  await previous;
  return () => {
    release();
    if (projectCommitLocks.get(projectPath) === tail) {
      projectCommitLocks.delete(projectPath);
    }
  };
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
      hidden: project.hidden === true ? true : undefined,
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
      projects.map(
        ({ path, collapsed, hidden, alias, worktreeOriginPath }) => ({
          path,
          collapsed,
          hidden,
          alias,
          worktreeOriginPath,
        }),
      ) as ClaudeProject[],
  });

const projectPathSchema = z.string().trim().min(1);
const gitBranchSchema = z.string().trim().min(1);
const gitCommitHashSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{4,64}$/i, "Invalid commit hash");

const editableFilePathSchema = z.string().trim().min(1);

async function getUncommittedFiles(
  projectPath: string,
  context: Pick<Services, "projectGitService">,
): Promise<FileDiffMetadata[]> {
  const diff = await context.projectGitService.getUncommittedDiff(projectPath);
  return diff
    ? assignDiffCacheKeys(
        parsePatchFiles(diff).flatMap((patch) => patch.files),
        `worktree:${projectPath}`,
      )
    : [];
}

function editableFileUnavailableReason(file: FileDiffMetadata): string | null {
  if (file.type === "deleted") {
    return "Deleted files are read-only in the diff pane.";
  }
  if (file.type === "rename-pure") {
    return "Rename-only changes are read-only in the diff pane.";
  }
  if (file.mode === "120000" || file.prevMode === "120000") {
    return "Symbolic links are read-only in the diff pane.";
  }
  return null;
}

function getFileDiffSourceSignature(file: FileDiffMetadata): string {
  if (file.prevObjectId || file.newObjectId) {
    return `${file.prevObjectId ?? "0000000"}..${file.newObjectId ?? "0000000"}`;
  }
  return file.hunks.map((hunk) => hunk.hunkSpecs ?? "").join("\n");
}

/**
 * Stamps every diff with a content-derived `cacheKey` before it reaches the
 * renderer.
 *
 * `@pierre/diffs` caches syntax-highlight ASTs in one app-wide LRU keyed solely
 * by `cacheKey`, and when we leave it unset the library falls back to the file
 * path. Every revision of a file then collides on one entry, so a refreshed
 * diff gets paired with the previous revision's AST — stale highlighting when
 * the content shrank, and a "deletionLine and additionLine are null" throw out
 * of `DiffHunksRenderer` once it grew past the cached line count. The blob pair
 * ties the entry to the exact content it was highlighted from.
 */
export function assignDiffCacheKeys(
  files: FileDiffMetadata[],
  scope: string,
): FileDiffMetadata[] {
  for (const file of files) {
    const source = `${file.prevName ?? file.name}>${file.name}`;
    file.cacheKey = `${scope}:${source}:${getFileDiffSourceSignature(file)}`;
  }
  return files;
}

function assertProjectFileEditingAllowed(
  projectPath: string,
  context: Pick<Services, "projectsState">,
): void {
  assertProjectPathInteractionAllowed(projectPath, context);
  if (
    !context.projectsState.state.some((project) => project.path === projectPath)
  ) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Files can only be edited inside a tracked project.",
    });
  }
}

async function loadEditableDiffFile(
  projectPath: string,
  file: FileDiffMetadata,
) {
  const unavailableReason = editableFileUnavailableReason(file);
  if (unavailableReason) {
    return { status: "unavailable" as const, reason: unavailableReason };
  }

  try {
    const snapshot = await readEditableFileSnapshot(projectPath, file.name);
    const newFile: FileContents = {
      name: file.name,
      contents: snapshot.contents,
      cacheKey: `working:${file.name}:${snapshot.revision}`,
    };
    const oldFile: FileContents | null =
      file.type === "new"
        ? null
        : {
            name: file.prevName ?? file.name,
            contents: await readGitFileContents(projectPath, {
              objectId: file.prevObjectId,
              filePath: file.prevName ?? file.name,
            }),
            cacheKey: `git:${file.prevObjectId ?? file.prevName ?? file.name}`,
          };
    if (oldFile?.contents === newFile.contents) {
      return {
        status: "unavailable" as const,
        reason:
          "Files with only metadata changes are read-only in the diff pane.",
      };
    }

    return {
      status: "ready" as const,
      sourceSignature: getFileDiffSourceSignature(file),
      revision: snapshot.revision,
      contents: snapshot.contents,
      fileDiff: parseDiffFromFile(oldFile, newFile, undefined, true),
    };
  } catch (error) {
    if (error instanceof UnsupportedEditableFileError) {
      return { status: "unavailable" as const, reason: error.message };
    }
    throw error;
  }
}

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

/**
 * Pushes behind the per-project commit lock so a push requested while the
 * auto-message flow is still generating waits for the pending amend instead
 * of publishing the placeholder commit (which the amend would then rewrite,
 * leaving the branch diverged from the remote it just pushed to).
 */
export async function pushProjectToRemote(
  path: string,
  context: {
    projectGitService: {
      pushToRemote(projectPath: string): Promise<void>;
    };
  },
): Promise<void> {
  const releaseCommitLock = await acquireProjectCommitLock(path);
  try {
    await context.projectGitService.pushToRemote(path);
  } finally {
    releaseCommitLock();
  }
}

/**
 * Pulls behind the same per-project commit lock as pushing, so a fast-forward
 * cannot land between the placeholder commit and the amend that rewrites it.
 */
export async function pullProjectFromRemote(
  path: string,
  context: {
    projectGitService: {
      pullFromRemote(projectPath: string): Promise<PullFromRemoteResult>;
    };
  },
): Promise<PullFromRemoteResult> {
  const releaseCommitLock = await acquireProjectCommitLock(path);
  try {
    return await context.projectGitService.pullFromRemote(path);
  } finally {
    releaseCommitLock();
  }
}

/**
 * Undoes HEAD behind the same per-project commit lock as commit/push/pull, so
 * a toast Undo cannot race the autogenerate amend that rewrites that commit.
 */
export async function undoLastCommit(
  path: string,
  context: {
    projectGitService: {
      undoLastCommit(projectPath: string): Promise<void>;
    };
  },
): Promise<void> {
  const releaseCommitLock = await acquireProjectCommitLock(path);
  try {
    await context.projectGitService.undoLastCommit(path);
  } finally {
    releaseCommitLock();
  }
}

interface CommitSelectedChangesGitService {
  getSelectedChangesDiff(
    projectPath: string,
    paths: string[],
  ): Promise<string | null>;
  commitSelectedChanges(
    projectPath: string,
    input: {
      paths: string[];
      subject: string;
      description?: string;
    },
  ): Promise<void>;
  getLastCommitDiff(
    projectPath: string,
    paths: string[],
  ): Promise<string | null>;
  amendLastCommitMessage(
    projectPath: string,
    input: {
      subject: string;
      description?: string;
    },
  ): Promise<void>;
}

/**
 * Commits selected paths with a placeholder, then amends in a generated
 * message. Generation starts from the uncommitted selected-file diff so it
 * overlaps the git commit instead of waiting for it.
 */
export async function* commitSelectedChangesWithGeneratedMessage(input: {
  path: string;
  filePaths: string[];
  description?: string;
  projectGitService: CommitSelectedChangesGitService;
  titleGeneration: TitleGenerationSettings;
  generateCommitMessage?: (
    settings: TitleGenerationSettings,
    diff: string,
  ) => Promise<GeneratedCommitMessage | null>;
}): AsyncGenerator<CommitProgressEvent> {
  const generate = input.generateCommitMessage ?? generateCommitMessage;
  const placeholderNote = formatCommittedWithPlaceholderNote();
  let generatedPromise: Promise<GeneratedCommitMessage | null> | null = null;

  try {
    const diff = await input.projectGitService.getSelectedChangesDiff(
      input.path,
      input.filePaths,
    );
    if (diff?.trim()) {
      generatedPromise = generate(input.titleGeneration, diff);
      yield { stage: "generating" } satisfies CommitProgressEvent;
    }
  } catch (error) {
    log.warn("Failed to read selected changes diff for commit message", {
      path: input.path,
      error,
    });
  }

  try {
    await input.projectGitService.commitSelectedChanges(input.path, {
      paths: input.filePaths,
      subject: autogenerateCommitPlaceholderSubject,
    });
  } catch (error) {
    void generatedPromise?.catch(() => undefined);
    const message =
      error instanceof Error && error.message.trim()
        ? error.message
        : "Git commit failed.";
    throw new ORPCError("BAD_REQUEST", { message });
  }

  yield { stage: "committed" } satisfies CommitProgressEvent;

  if (!generatedPromise) {
    yield { stage: "generating" } satisfies CommitProgressEvent;
  }

  try {
    let generated: GeneratedCommitMessage | null = null;
    if (generatedPromise) {
      generated = await generatedPromise;
    } else {
      const diff = await input.projectGitService.getLastCommitDiff(
        input.path,
        input.filePaths,
      );
      if (!diff) {
        throw new ORPCError("BAD_REQUEST", {
          message: `Failed to generate commit message. ${placeholderNote}`,
        });
      }
      generated = await generate(input.titleGeneration, diff);
    }

    if (!generated?.subject.trim()) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Failed to generate commit message. ${placeholderNote}`,
      });
    }

    const finalSubject = generated.subject.trim();
    const finalDescription = input.description ?? generated.description?.trim();

    try {
      await input.projectGitService.amendLastCommitMessage(input.path, {
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
  getFavicon: procedure
    .input(z.object({ path: projectPathSchema }))
    .handler(async ({ input }) => ({
      dataUrl: await getProjectFaviconDataUrl(normalizeProjectPath(input.path)),
    })),
  // Clearing is all this does: the renderer refetches `getFavicon` behind it,
  // and that request is what pays for the rescan.
  refreshFavicon: procedure
    .input(z.object({ path: projectPathSchema }))
    .handler(async ({ input }) => {
      invalidateProjectFavicon(normalizeProjectPath(input.path));
    }),
  getUncommittedDiff: procedure
    .input(z.object({ path: projectPathSchema }))
    .handler(async ({ input, context }) => {
      try {
        return await getUncommittedFiles(
          normalizeProjectPath(input.path),
          context,
        );
      } catch (error) {
        // oRPC rewrites a plain Error's message to "Internal server error" on
        // the way to the renderer; restating it keeps the real cause visible.
        const message =
          error instanceof Error && error.message.trim()
            ? error.message
            : "Failed to read uncommitted changes.";
        throw new ORPCError("INTERNAL_SERVER_ERROR", { message });
      }
    }),
  getEditableDiffFile: procedure
    .input(
      z.object({
        path: projectPathSchema,
        filePath: editableFilePathSchema,
      }),
    )
    .handler(async ({ input, context }) => {
      const projectPath = normalizeProjectPath(input.path);
      assertProjectFileEditingAllowed(projectPath, context);
      const files = await getUncommittedFiles(projectPath, context);
      const file = files.find((candidate) => candidate.name === input.filePath);
      if (!file) {
        return {
          status: "unavailable" as const,
          reason: "This file is no longer part of the working-tree diff.",
        };
      }
      try {
        return await loadEditableDiffFile(projectPath, file);
      } catch (error) {
        const message =
          error instanceof Error && error.message.trim()
            ? error.message
            : "Failed to prepare this file for editing.";
        return { status: "unavailable" as const, reason: message };
      }
    }),
  saveEditableDiffFile: procedure
    .input(
      z.object({
        path: projectPathSchema,
        filePath: editableFilePathSchema,
        contents: z.string(),
        expectedRevision: z.string().regex(/^[0-9a-f]{64}$/i),
      }),
    )
    .handler(async ({ input, context }) => {
      const projectPath = normalizeProjectPath(input.path);
      assertProjectFileEditingAllowed(projectPath, context);
      try {
        const result = await saveEditableFileSnapshot(projectPath, input);
        const files = await getUncommittedFiles(projectPath, context);
        return {
          status: "saved" as const,
          revision: result.revision,
          fileDiff:
            files.find((candidate) => candidate.name === input.filePath) ??
            null,
        };
      } catch (error) {
        if (error instanceof EditableFileConflictError) {
          return { status: "conflict" as const };
        }
        if (error instanceof UnsupportedEditableFileError) {
          throw new ORPCError("BAD_REQUEST", { message: error.message });
        }
        const message =
          error instanceof Error && error.message.trim()
            ? error.message
            : "Failed to save this file.";
        throw new ORPCError("INTERNAL_SERVER_ERROR", { message });
      }
    }),
  getCommitHistory: procedure
    .input(
      z.object({
        path: projectPathSchema,
        cursor: gitCommitHashSchema.optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      return context.projectGitService.getCommitHistory(
        normalizeProjectPath(input.path),
        {
          cursor: input.cursor,
          limit: input.limit ?? 30,
        },
      );
    }),
  getCommitDiff: procedure
    .input(
      z.object({
        path: projectPathSchema,
        commitHash: gitCommitHashSchema,
      }),
    )
    .handler(async ({ input, context }) => {
      const projectPath = normalizeProjectPath(input.path);
      const diff = await context.projectGitService.getCommitDiff(
        projectPath,
        input.commitHash,
      );
      if (!diff) return [] as FileDiffMetadata[];
      return assignDiffCacheKeys(
        parsePatchFiles(diff).flatMap((p) => p.files),
        `commit:${projectPath}:${input.commitHash}`,
      );
    }),
  pushToRemote: procedure
    .input(z.object({ path: projectPathSchema }))
    .handler(async ({ input, context }) => {
      const path = normalizeProjectPath(input.path);
      assertProjectPathInteractionAllowed(path, context);
      try {
        await pushProjectToRemote(path, context);
      } catch (error) {
        // oRPC rewrites a plain Error's message to "Internal server error" on
        // the way to the renderer, which would drop the git-specific copy.
        throw new ORPCError("BAD_REQUEST", {
          message:
            error instanceof Error && error.message.trim()
              ? error.message
              : "Git push failed.",
        });
      }
    }),
  pullFromRemote: procedure
    .input(z.object({ path: projectPathSchema }))
    .handler(async ({ input, context }) => {
      const path = normalizeProjectPath(input.path);
      assertProjectPathInteractionAllowed(path, context);
      try {
        return await pullProjectFromRemote(path, context);
      } catch (error) {
        throw new ORPCError("BAD_REQUEST", {
          message:
            error instanceof Error && error.message.trim()
              ? error.message
              : "Git pull failed.",
        });
      }
    }),
  undoLastCommit: procedure
    .input(z.object({ path: projectPathSchema }))
    .handler(async ({ input, context }) => {
      const path = normalizeProjectPath(input.path);
      assertProjectPathInteractionAllowed(path, context);
      try {
        await undoLastCommit(path, context);
      } catch (error) {
        throw new ORPCError("BAD_REQUEST", {
          message:
            error instanceof Error && error.message.trim()
              ? error.message
              : "Failed to undo commit.",
        });
      }
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

      const releaseCommitLock = await acquireProjectCommitLock(path);
      try {
        if (!subject) {
          yield* commitSelectedChangesWithGeneratedMessage({
            path,
            filePaths: input.filePaths,
            description,
            projectGitService: context.projectGitService,
            titleGeneration: context.appSettingsState.state.titleGeneration,
          });
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
      } finally {
        releaseCommitLock();
      }
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
  setProjectHidden: procedure
    .input(z.object({ path: projectPathSchema, hidden: z.boolean() }))
    .handler(async ({ input, context }) => {
      const path = normalizeProjectPath(input.path);
      if (!path) return;

      assertProjectPathInteractionAllowed(path, context);

      context.projectsState.updateState((projects) => {
        const project = projects.find((p) => p.path === path);
        if (!project) return;
        const hidden = input.hidden ? true : undefined;
        if (project.hidden === hidden) return;
        project.hidden = hidden;
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
  // Read straight from disk on every call: the file is checked into the repo
  // and edited outside the app, so a cached copy would go stale unnoticed.
  listCommands: procedure
    .input(z.object({ path: projectPathSchema }))
    .handler(async ({ input }) => {
      const path = normalizeProjectPath(input.path);
      if (!path) return { commands: [], scripts: [] };
      const [commands, scripts] = await Promise.all([
        readProjectCommands(path),
        readProjectScripts(path),
      ]);
      return { commands, scripts };
    }),
  setCommands: procedure
    .input(
      z.object({
        path: projectPathSchema,
        commands: z
          .array(projectCommandWriteSchema)
          .max(PROJECT_COMMANDS_LIMIT),
      }),
    )
    .handler(async ({ input, context }) => {
      const path = normalizeProjectPath(input.path);
      if (!path) return { commands: [] };

      assertProjectPathInteractionAllowed(path, context);

      await writeProjectCommands(path, input.commands);
      return { commands: await readProjectCommands(path) };
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
