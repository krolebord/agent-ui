import { readdir } from "node:fs/promises";
import path from "node:path";
import type {
  ClaudeProject,
  GitDiffStats,
  GitUpstreamDiffStats,
} from "@shared/claude-types";
import { buildSuggestedWorktreePath } from "@shared/project-worktree";
import simpleGit from "simple-git";
import log from "./logger";
import type { ProjectState } from "./project-service";
import {
  type ProjectSettingsFile,
  writeProjectSettingsFile,
} from "./project-settings-file";
import { parseSetupCommands } from "./sessions/worktree-setup.session";

const EMPTY_GIT_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

type ProjectGitMetadata = Pick<
  ClaudeProject,
  "gitBranch" | "gitDiffStats" | "gitUpstreamDiffStats"
>;

interface ProjectGitData {
  currentBranch?: string;
  diffStats: GitDiffStats;
  upstreamDiffStats?: GitUpstreamDiffStats;
  isRepo: boolean;
  localBranches: string[];
  git: ReturnType<typeof simpleGit>;
}

function getDiscoveredLocalBranchNames(summary: {
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

  return localBranches;
}

function alphabetizeBranchNames(branches: string[]): string[] {
  return [...branches].sort((a, b) => a.localeCompare(b));
}

function parseBranchOrderOutput(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function getLocalBranchNames(
  git: ReturnType<typeof simpleGit>,
  summary: {
    current?: string | null;
    branches?: Record<string, unknown>;
  },
): Promise<string[]> {
  const discoveredBranches = getDiscoveredLocalBranchNames(summary);
  if (!discoveredBranches.length) {
    return [];
  }

  try {
    const orderedBranchesOutput = await git.raw([
      "branch",
      "--format=%(refname:short)",
      "--sort=-committerdate",
    ]);
    const discoveredBranchSet = new Set(discoveredBranches);
    const orderedBranches = parseBranchOrderOutput(
      orderedBranchesOutput,
    ).filter((branch) => discoveredBranchSet.has(branch));

    if (!orderedBranches.length) {
      return alphabetizeBranchNames(discoveredBranches);
    }

    const seenBranches = new Set(orderedBranches);
    for (const branch of alphabetizeBranchNames(discoveredBranches)) {
      if (!seenBranches.has(branch)) {
        orderedBranches.push(branch);
      }
    }

    return orderedBranches;
  } catch {
    return alphabetizeBranchNames(discoveredBranches);
  }
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

function parseGitDiffStats(diffSummary: string): GitDiffStats {
  let addedLines = 0;
  let deletedLines = 0;

  for (const line of diffSummary.trim().split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const [addedValue, deletedValue] = trimmed.split("\t");
    const added = Number.parseInt(addedValue ?? "", 10);
    const deleted = Number.parseInt(deletedValue ?? "", 10);

    if (Number.isFinite(added)) {
      addedLines += added;
    }
    if (Number.isFinite(deleted)) {
      deletedLines += deleted;
    }
  }

  return { addedLines, deletedLines };
}

function parseAheadBehindSummary(
  revListSummary: string,
): { aheadCommits: number; behindCommits: number } | undefined {
  const [behindValue, aheadValue] = revListSummary.trim().split(/\s+/);
  const behindCommits = Number.parseInt(behindValue ?? "", 10);
  const aheadCommits = Number.parseInt(aheadValue ?? "", 10);

  if (!Number.isFinite(behindCommits) || !Number.isFinite(aheadCommits)) {
    return undefined;
  }

  return { aheadCommits, behindCommits };
}

async function resolveDiffBaseRef(
  git: ReturnType<typeof simpleGit>,
): Promise<string> {
  try {
    await git.raw(["rev-parse", "--verify", "HEAD"]);
    return "HEAD";
  } catch {
    return EMPTY_GIT_TREE_HASH;
  }
}

async function resolveUpstreamDiffStats(
  git: ReturnType<typeof simpleGit>,
  currentBranch: string | undefined,
): Promise<GitUpstreamDiffStats | undefined> {
  if (!currentBranch || currentBranch === "(no branch)") {
    return undefined;
  }

  try {
    const upstreamBranch = (
      await git.raw([
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ])
    ).trim();
    if (!upstreamBranch) {
      return undefined;
    }

    const revListSummary = await git.raw([
      "rev-list",
      "--left-right",
      "--count",
      `${upstreamBranch}...HEAD`,
    ]);
    const aheadBehindCounts = parseAheadBehindSummary(revListSummary);
    if (!aheadBehindCounts) {
      return undefined;
    }

    return {
      upstreamBranch,
      aheadCommits: aheadBehindCounts.aheadCommits,
      behindCommits: aheadBehindCounts.behindCommits,
    };
  } catch {
    return undefined;
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
      diffStats: { addedLines: 0, deletedLines: 0 },
      localBranches: [],
    };
  }

  const summary = await git.branchLocal();
  const currentBranch = summary.current ?? undefined;
  const diffBaseRef = await resolveDiffBaseRef(git);
  await git.raw(["add", "-A"]);
  const diffSummary = await git.raw([
    "diff",
    "--cached",
    "--numstat",
    "--no-renames",
    diffBaseRef,
  ]);
  const diffStats = parseGitDiffStats(diffSummary);

  return {
    git,
    isRepo: true,
    currentBranch,
    diffStats,
    upstreamDiffStats: await resolveUpstreamDiffStats(git, currentBranch),
    localBranches: await getLocalBranchNames(git, summary),
  };
}

function projectGitMetadataEquals(
  current: ProjectGitMetadata | undefined,
  next: ProjectGitMetadata,
): boolean {
  return (
    current?.gitBranch === next.gitBranch &&
    current?.gitDiffStats?.addedLines === next.gitDiffStats?.addedLines &&
    current?.gitDiffStats?.deletedLines === next.gitDiffStats?.deletedLines &&
    current?.gitUpstreamDiffStats?.upstreamBranch ===
      next.gitUpstreamDiffStats?.upstreamBranch &&
    current?.gitUpstreamDiffStats?.aheadCommits ===
      next.gitUpstreamDiffStats?.aheadCommits &&
    current?.gitUpstreamDiffStats?.behindCommits ===
      next.gitUpstreamDiffStats?.behindCommits
  );
}

async function resolveProjectGitMetadata(
  projectPath: string,
): Promise<ProjectGitMetadata> {
  try {
    const projectGitData = await readProjectGitData(projectPath);
    if (!projectGitData.isRepo) {
      return {
        gitBranch: undefined,
        gitDiffStats: undefined,
        gitUpstreamDiffStats: undefined,
      };
    }

    return {
      gitBranch: projectGitData.currentBranch,
      gitDiffStats: projectGitData.diffStats,
      gitUpstreamDiffStats: projectGitData.upstreamDiffStats,
    };
  } catch (error) {
    const gitError = error as { message?: string };
    if (gitError?.message) {
      log.warn("Failed to resolve git branch", {
        projectPath,
        message: gitError.message,
      });
    }

    return {
      gitBranch: undefined,
      gitDiffStats: undefined,
      gitUpstreamDiffStats: undefined,
    };
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
    worktreeSetupCommands: project?.worktreeSetupCommands,
  };
}

function hasProjectSettings(settings: ProjectSettingsFile): boolean {
  return Boolean(
    settings.localClaude ||
      settings.localCodex ||
      settings.localCursor ||
      settings.worktreeSetupCommands,
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

function isDirtyWorktreeRemovalError(error: unknown): boolean {
  const gitError = error as { message?: string };
  return (
    typeof gitError?.message === "string" &&
    gitError.message.includes("contains modified or untracked files")
  );
}

export type DeleteWorktreeProjectResult =
  | {
      warning?: string;
      requiresForce?: false;
      errorMessage?: undefined;
    }
  | {
      requiresForce: true;
      errorMessage: string;
      warning?: undefined;
    };

export type PerformDeleteWorktreeFolderResult = {
  warning?: string;
};

async function isWorktreeWorkingTreeClean(
  worktreePath: string,
): Promise<boolean> {
  const worktreeGit = simpleGit(worktreePath);
  const porcelain = await worktreeGit.raw(["status", "--porcelain"]);
  return porcelain.trim().length === 0;
}

export class ProjectGitService {
  private refreshInFlight: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly projectsState: ProjectState) {}

  start(): void {
    this.triggerRefresh();
  }

  async refreshProject(projectPath: string): Promise<void> {
    const metadata = await resolveProjectGitMetadata(projectPath);
    if (this.disposed) {
      return;
    }

    const project = this.projectsState.state.find(
      (item) => item.path === projectPath,
    );
    if (!project || projectGitMetadataEquals(project, metadata)) {
      return;
    }

    this.projectsState.updateState((projects) => {
      const draft = projects.find((item) => item.path === projectPath);
      if (!draft || projectGitMetadataEquals(draft, metadata)) {
        return;
      }
      draft.gitBranch = metadata.gitBranch;
      draft.gitDiffStats = metadata.gitDiffStats;
      draft.gitUpstreamDiffStats = metadata.gitUpstreamDiffStats;
    });
  }

  async getWorktreeCreationData(projectPath: string): Promise<{
    currentBranch: string;
    localBranches: string[];
    suggestedDestinationPath: string;
    suggestedDestinationParentPath: string;
    sourceProjectName: string;
  }> {
    const sourceProject = this.projectsState.state.find(
      (project) => project.path === projectPath,
    );
    if (sourceProject?.worktreeOriginPath) {
      throw new Error(
        "Cannot create a worktree from a project that is itself a worktree.",
      );
    }

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
  }): Promise<{
    path: string;
    projectRoot: string;
    worktreeRoot: string;
    setupCommands: string[];
  }> {
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
    if (sourceProject?.worktreeOriginPath) {
      throw new Error(
        "Cannot create a worktree from a project that is itself a worktree.",
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

    const setupCommands = parseSetupCommands(
      sourceProject?.worktreeSetupCommands,
    );

    if (!this.disposed) {
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
    }

    return {
      path: destinationPath,
      projectRoot: sourcePath,
      worktreeRoot: destinationPath,
      setupCommands,
    };
  }

  private assertDeleteWorktreeProjectInput(
    input: {
      path: string;
      deleteFolder: boolean;
      deleteBranch: boolean;
    },
    project: ClaudeProject | undefined,
  ): asserts project is ClaudeProject & { worktreeOriginPath: string } {
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
  }

  /**
   * When not forcing removal, checks the worktree is clean (porcelain status).
   * Returns `requiresForce` if the user must enable force delete.
   */
  async preflightDeleteWorktreeFolder(input: {
    path: string;
    deleteFolder: boolean;
    deleteBranch: boolean;
    forceDeleteFolder: boolean;
  }): Promise<DeleteWorktreeProjectResult | null> {
    const projectPath = input.path.trim();
    const project = this.projectsState.state.find(
      (item) => item.path === projectPath,
    );

    this.assertDeleteWorktreeProjectInput(input, project);

    if (!input.deleteFolder) {
      return null;
    }

    if (!input.forceDeleteFolder) {
      const clean = await isWorktreeWorkingTreeClean(projectPath);
      if (!clean) {
        return {
          requiresForce: true,
          errorMessage:
            "Project folder has modified or untracked files. Enable force delete to remove the worktree and discard those changes.",
        };
      }
    }

    return null;
  }

  /**
   * Removes the Git worktree folder and optionally deletes the local branch.
   * Call only after `preflightDeleteWorktreeFolder` passes (or `forceDeleteFolder` is true).
   */
  async performDeleteWorktreeFolderAndBranch(input: {
    path: string;
    deleteFolder: boolean;
    deleteBranch: boolean;
    forceDeleteFolder: boolean;
  }): Promise<PerformDeleteWorktreeFolderResult> {
    const projectPath = input.path.trim();
    const project = this.projectsState.state.find(
      (item) => item.path === projectPath,
    );

    this.assertDeleteWorktreeProjectInput(input, project);

    if (!input.deleteFolder) {
      return {};
    }

    const sourceGit = simpleGit(project.worktreeOriginPath);
    const removeWorktreeArgs = ["worktree", "remove"];
    if (input.forceDeleteFolder) {
      removeWorktreeArgs.push("--force");
    }
    removeWorktreeArgs.push(projectPath);

    try {
      await sourceGit.raw(removeWorktreeArgs);
    } catch (error) {
      if (!input.forceDeleteFolder && isDirtyWorktreeRemovalError(error)) {
        throw new Error(
          "Project folder has modified or untracked files. Enable force delete to remove the worktree and discard those changes.",
        );
      }

      throw error;
    }

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

  async deleteWorktreeProject(input: {
    path: string;
    deleteFolder: boolean;
    deleteBranch: boolean;
    forceDeleteFolder: boolean;
  }): Promise<DeleteWorktreeProjectResult> {
    const projectPath = input.path.trim();
    const project = this.projectsState.state.find(
      (item) => item.path === projectPath,
    );

    this.assertDeleteWorktreeProjectInput(input, project);

    if (!input.deleteFolder) {
      return {};
    }

    const preflight = await this.preflightDeleteWorktreeFolder(input);
    if (preflight?.requiresForce) {
      return preflight;
    }

    return await this.performDeleteWorktreeFolderAndBranch(input);
  }

  async refreshAll(): Promise<void> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = (async () => {
      const projectPaths = this.projectsState.state.map(
        (project) => project.path,
      );
      const metadataEntries = await Promise.all(
        projectPaths.map(
          async (projectPath) =>
            [
              projectPath,
              await resolveProjectGitMetadata(projectPath),
            ] as const,
        ),
      );

      if (this.disposed) {
        return;
      }

      const metadataByPath = new Map(metadataEntries);
      const hasChanges = metadataEntries.some(
        ([projectPath, metadata]) =>
          !projectGitMetadataEquals(
            this.projectsState.state.find(
              (project) => project.path === projectPath,
            ),
            metadata,
          ),
      );

      if (!hasChanges) {
        return;
      }

      this.projectsState.updateState((projects) => {
        for (const project of projects) {
          const metadata = metadataByPath.get(project.path);
          if (!metadata) {
            continue;
          }

          if (projectGitMetadataEquals(project, metadata)) {
            continue;
          }

          project.gitBranch = metadata.gitBranch;
          project.gitDiffStats = metadata.gitDiffStats;
          project.gitUpstreamDiffStats = metadata.gitUpstreamDiffStats;
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
  }
}
