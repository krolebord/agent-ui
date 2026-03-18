import { readdir } from "node:fs/promises";
import path from "node:path";
import type { ClaudeProject } from "@shared/claude-types";
import { buildSuggestedWorktreePath } from "@shared/project-worktree";
import simpleGit from "simple-git";
import log from "./logger";
import type { ProjectState } from "./project-service";
import {
  type ProjectSettingsFile,
  writeProjectSettingsFile,
} from "./project-settings-file";

const DEFAULT_GIT_REFRESH_INTERVAL_MS = 15_000;

interface ProjectGitData {
  currentBranch?: string;
  isRepo: boolean;
  localBranches: string[];
  git: ReturnType<typeof simpleGit>;
}

function getLocalBranchNames(summary: {
  current?: string | null;
  branches?: Record<string, unknown>;
}): string[] {
  const localBranches = Object.keys(summary.branches ?? {});
  if (
    summary.current &&
    !localBranches.includes(summary.current) &&
    summary.current !== "(no branch)"
  ) {
    localBranches.push(summary.current);
  }

  return localBranches.sort((a, b) => a.localeCompare(b));
}

async function isExistingNonEmptyPath(targetPath: string): Promise<boolean> {
  try {
    const entries = await readdir(targetPath);
    return entries.length > 0;
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException;
    if (fsError?.code === "ENOENT") {
      return false;
    }

    return true;
  }
}

async function readProjectGitData(
  projectPath: string,
): Promise<ProjectGitData> {
  const git = simpleGit(projectPath);
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    return {
      git,
      isRepo: false,
      localBranches: [],
    };
  }

  const summary = await git.branchLocal();
  return {
    git,
    isRepo: true,
    currentBranch: summary.current ?? undefined,
    localBranches: getLocalBranchNames(summary),
  };
}

async function resolveGitBranch(
  projectPath: string,
): Promise<string | undefined> {
  try {
    const projectGitData = await readProjectGitData(projectPath);
    if (!projectGitData.isRepo) {
      return undefined;
    }

    return projectGitData.currentBranch;
  } catch (error) {
    const gitError = error as { message?: string };
    if (gitError?.message) {
      log.warn("Failed to resolve git branch", {
        projectPath,
        message: gitError.message,
      });
    }

    return undefined;
  }
}

function getProjectSettingsSnapshot(
  project?: ClaudeProject,
): ProjectSettingsFile {
  return {
    localClaude: project?.localClaude
      ? structuredClone(project.localClaude)
      : undefined,
    localCodex: project?.localCodex
      ? structuredClone(project.localCodex)
      : undefined,
    localCursor: project?.localCursor
      ? structuredClone(project.localCursor)
      : undefined,
  };
}

function hasProjectSettings(settings: ProjectSettingsFile): boolean {
  return Boolean(
    settings.localClaude || settings.localCodex || settings.localCursor,
  );
}

function getDefaultWorktreeBranch(projectGitData: ProjectGitData): string {
  if (
    projectGitData.currentBranch &&
    projectGitData.localBranches.includes(projectGitData.currentBranch)
  ) {
    return projectGitData.currentBranch;
  }

  const [fallbackBranch] = projectGitData.localBranches;
  if (fallbackBranch) {
    return fallbackBranch;
  }

  throw new Error(
    "Project has no local branches available for worktree creation.",
  );
}

export class ProjectGitService {
  private readonly refreshIntervalMs: number;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly projectsState: ProjectState,
    options?: { refreshIntervalMs?: number },
  ) {
    this.refreshIntervalMs =
      options?.refreshIntervalMs ?? DEFAULT_GIT_REFRESH_INTERVAL_MS;
  }

  start(): void {
    this.triggerRefresh();

    this.refreshTimer = setInterval(() => {
      this.triggerRefresh();
    }, this.refreshIntervalMs);
    this.refreshTimer.unref?.();
  }

  async refreshProject(projectPath: string): Promise<void> {
    const gitBranch = await resolveGitBranch(projectPath);
    if (this.disposed) {
      return;
    }

    const project = this.projectsState.state.find(
      (item) => item.path === projectPath,
    );
    if (!project || project.gitBranch === gitBranch) {
      return;
    }

    this.projectsState.updateState((projects) => {
      const draft = projects.find((item) => item.path === projectPath);
      if (!draft || draft.gitBranch === gitBranch) {
        return;
      }
      draft.gitBranch = gitBranch;
    });
  }

  async getWorktreeCreationData(projectPath: string): Promise<{
    currentBranch: string;
    localBranches: string[];
    suggestedDestinationPath: string;
    suggestedDestinationParentPath: string;
    sourceProjectName: string;
  }> {
    const projectGitData = await readProjectGitData(projectPath);
    if (!projectGitData.isRepo) {
      throw new Error("Project is not a Git repository.");
    }
    const currentBranch = getDefaultWorktreeBranch(projectGitData);

    return {
      currentBranch,
      localBranches: projectGitData.localBranches,
      suggestedDestinationPath: buildSuggestedWorktreePath(
        projectPath,
        currentBranch,
      ),
      suggestedDestinationParentPath: path.dirname(projectPath),
      sourceProjectName: path.basename(projectPath),
    };
  }

  async createWorktreeProject(input: {
    sourcePath: string;
    fromBranch: string;
    newBranch: string;
    destinationPath: string;
    alias?: string;
  }): Promise<{ path: string }> {
    const sourcePath = input.sourcePath.trim();
    const fromBranch = input.fromBranch.trim();
    const newBranch = input.newBranch.trim();
    const destinationPath = input.destinationPath.trim();
    const alias = input.alias?.trim() || undefined;
    const sourceProject = this.projectsState.state.find(
      (project) => project.path === sourcePath,
    );

    if (!sourcePath || !fromBranch || !newBranch || !destinationPath) {
      throw new Error(
        "Source path, branches, and destination path are required.",
      );
    }
    if (
      this.projectsState.state.some(
        (project) => project.path === destinationPath,
      )
    ) {
      throw new Error("A tracked project already exists at that path.");
    }

    const projectGitData = await readProjectGitData(sourcePath);
    if (!projectGitData.isRepo) {
      throw new Error("Project is not a Git repository.");
    }
    if (!projectGitData.localBranches.includes(fromBranch)) {
      throw new Error("Selected source branch was not found locally.");
    }
    if (projectGitData.localBranches.includes(newBranch)) {
      throw new Error("A local branch with that name already exists.");
    }
    if (await isExistingNonEmptyPath(destinationPath)) {
      throw new Error("Destination path already exists and is not empty.");
    }

    await projectGitData.git.raw([
      "worktree",
      "add",
      "-b",
      newBranch,
      destinationPath,
      fromBranch,
    ]);

    const sourceProjectSettings = getProjectSettingsSnapshot(sourceProject);
    if (hasProjectSettings(sourceProjectSettings)) {
      await writeProjectSettingsFile(destinationPath, sourceProjectSettings);
    }

    if (this.disposed) {
      return { path: destinationPath };
    }

    this.projectsState.updateState((projects) => {
      if (projects.some((project) => project.path === destinationPath)) {
        return;
      }

      projects.push({
        path: destinationPath,
        collapsed: false,
        alias,
        worktreeOriginPath: sourcePath,
        ...sourceProjectSettings,
      });
    });

    await this.refreshProject(destinationPath);

    return { path: destinationPath };
  }

  async deleteWorktreeProject(input: {
    path: string;
    deleteFolder: boolean;
    deleteBranch: boolean;
  }): Promise<{ warning?: string }> {
    const projectPath = input.path.trim();
    const project = this.projectsState.state.find(
      (item) => item.path === projectPath,
    );

    if (!project?.worktreeOriginPath) {
      throw new Error("Project is not a tracked worktree.");
    }
    if (input.deleteBranch && !input.deleteFolder) {
      throw new Error(
        "Deleting a worktree branch also requires deleting the folder.",
      );
    }
    if (input.deleteBranch && !project.gitBranch) {
      throw new Error(
        "Worktree project does not have a local branch to delete.",
      );
    }
    if (!input.deleteFolder) {
      return {};
    }

    const sourceGit = simpleGit(project.worktreeOriginPath);
    await sourceGit.raw(["worktree", "remove", projectPath]);

    if (!input.deleteBranch || !project.gitBranch) {
      return {};
    }

    try {
      await sourceGit.raw(["branch", "-d", project.gitBranch]);
      return {};
    } catch (error) {
      const gitError = error as { message?: string };
      return {
        warning: gitError?.message?.trim()
          ? `Worktree folder was removed, but deleting local branch "${project.gitBranch}" failed: ${gitError.message}`
          : `Worktree folder was removed, but deleting local branch "${project.gitBranch}" failed.`,
      };
    }
  }

  async refreshAll(): Promise<void> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = (async () => {
      const projectPaths = this.projectsState.state.map(
        (project) => project.path,
      );
      const branches = await Promise.all(
        projectPaths.map(
          async (projectPath) =>
            [projectPath, await resolveGitBranch(projectPath)] as const,
        ),
      );

      if (this.disposed) {
        return;
      }

      const branchByPath = new Map(branches);
      const currentBranchByPath = new Map(
        this.projectsState.state.map((project) => [
          project.path,
          project.gitBranch,
        ]),
      );
      const hasChanges = branches.some(
        ([projectPath, gitBranch]) =>
          currentBranchByPath.get(projectPath) !== gitBranch,
      );

      if (!hasChanges) {
        return;
      }

      this.projectsState.updateState((projects) => {
        for (const project of projects) {
          if (!branchByPath.has(project.path)) {
            continue;
          }

          const gitBranch = branchByPath.get(project.path);
          if (project.gitBranch === gitBranch) {
            continue;
          }

          project.gitBranch = gitBranch;
        }
      });
    })().finally(() => {
      this.refreshInFlight = null;
    });

    return this.refreshInFlight;
  }

  private triggerRefresh(): void {
    void this.refreshAll().catch((error) => {
      if (this.disposed) {
        return;
      }

      log.error("Unexpected project git refresh failure", { error });
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
