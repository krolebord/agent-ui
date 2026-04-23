import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ClaudeProject,
  GitDiffStats,
  GitUpstreamDiffStats,
} from "@shared/claude-types";
import { buildSuggestedWorktreePath } from "@shared/project-worktree";
import chokidar, { type FSWatcher } from "chokidar";
import simpleGit from "simple-git";
import log from "./logger";
import type { ProjectState } from "./project-service";
import {
  type ProjectSettingsFile,
  writeProjectSettingsFile,
} from "./project-settings-file";
import { parseSetupCommands } from "./sessions/worktree-setup.session";

const EMPTY_GIT_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GIT_STATUS_WATCH_DEBOUNCE_MS = 5_000;
const gitIndexPathCache = new Map<string, string>();

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

interface ProjectWatcherState {
  debounceTimer: ReturnType<typeof setTimeout> | null;
  ignoredPaths: Set<string>;
  ignoredPathsRefreshInFlight: Promise<void> | null;
  watcher: FSWatcher;
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

function parseNullDelimitedOutput(output: string): string[] {
  return output
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeWatchedRelativePath(watchedPath: string): string | null {
  const normalized = watchedPath.replaceAll("\\", "/").trim();
  if (!normalized || normalized === ".") {
    return null;
  }

  const withoutLeadingDotSlash = normalized.startsWith("./")
    ? normalized.slice(2)
    : normalized;
  const segments = withoutLeadingDotSlash.split("/").filter(Boolean);
  if (segments.length === 0 || segments.includes("..")) {
    return null;
  }

  return segments.join("/");
}

function isGitignoredPath(
  relativePath: string | null,
  ignoredPaths: Set<string>,
): boolean {
  if (!relativePath) {
    return false;
  }

  for (const ignoredPath of ignoredPaths) {
    if (
      relativePath === ignoredPath ||
      relativePath.startsWith(`${ignoredPath}/`)
    ) {
      return true;
    }
  }

  return false;
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

async function readGitignoredPaths(projectPath: string): Promise<Set<string>> {
  try {
    const git = simpleGit(projectPath);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      return new Set();
    }

    const ignoredOutput = await git.raw([
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ]);

    return new Set(
      parseNullDelimitedOutput(ignoredOutput)
        .map(normalizeWatchedRelativePath)
        .filter((entry): entry is string => entry !== null),
    );
  } catch {
    return new Set();
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

async function withTemporaryIndex<T>(
  git: ReturnType<typeof simpleGit>,
  projectPath: string,
  operation: (tempGit: ReturnType<typeof simpleGit>) => Promise<T>,
): Promise<T> {
  const now = performance.now();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "claude-ui-git-index-"));
  const tempIndexPath = path.join(tempDir, "index");

  try {
    await copyGitIndexToTemporaryIndex(git, projectPath, tempIndexPath);

    const tempGit = simpleGit(projectPath).env("GIT_INDEX_FILE", tempIndexPath);
    const result = await operation(tempGit);
    return result;
  } finally {
    await rm(tempDir, { recursive: true, force: true });

    const duration = performance.now() - now;
    log.info("withTemporaryIndex duration", { duration });
  }
}

async function resolveGitIndexPath(
  git: ReturnType<typeof simpleGit>,
  projectPath: string,
  options?: {
    bypassCache?: boolean;
  },
): Promise<string> {
  const bypassCache = options?.bypassCache ?? false;
  if (!bypassCache) {
    const cachedPath = gitIndexPathCache.get(projectPath);
    if (cachedPath) {
      return cachedPath;
    }
  }

  const gitIndexPath = (
    await git.raw(["rev-parse", "--git-path", "index"])
  ).trim();

  const resolvedGitIndexPath = path.isAbsolute(gitIndexPath)
    ? gitIndexPath
    : path.resolve(projectPath, gitIndexPath);
  gitIndexPathCache.set(projectPath, resolvedGitIndexPath);
  return resolvedGitIndexPath;
}

async function copyGitIndexToTemporaryIndex(
  git: ReturnType<typeof simpleGit>,
  projectPath: string,
  tempIndexPath: string,
): Promise<void> {
  let resolvedGitIndexPath = await resolveGitIndexPath(git, projectPath);

  try {
    await copyFile(resolvedGitIndexPath, tempIndexPath);
    return;
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException;
    if (fsError.code !== "ENOENT") {
      throw error;
    }
  }

  gitIndexPathCache.delete(projectPath);
  resolvedGitIndexPath = await resolveGitIndexPath(git, projectPath, {
    bypassCache: true,
  });

  try {
    await copyFile(resolvedGitIndexPath, tempIndexPath);
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException;
    if (fsError.code !== "ENOENT") {
      throw error;
    }

    await writeFile(tempIndexPath, "");
  }
}

async function readProjectGitData(
  projectPath: string,
  options?: {
    includeLocalBranches?: boolean;
  },
): Promise<ProjectGitData> {
  const includeLocalBranches = options?.includeLocalBranches ?? false;
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
  const currentBranch =
    summary.current ||
    (
      await git.raw(["symbolic-ref", "--short", "HEAD"]).catch(() => "")
    ).trim() ||
    undefined;
  const diffBaseRef = await resolveDiffBaseRef(git);
  const diffSummary = await withTemporaryIndex(
    git,
    projectPath,
    async (tempGit) => {
      await tempGit.raw(["add", "-A"]);
      return await tempGit.raw([
        "diff",
        "--cached",
        "--numstat",
        "--no-renames",
        diffBaseRef,
      ]);
    },
  );
  const diffStats = parseGitDiffStats(diffSummary);

  return {
    git,
    isRepo: true,
    currentBranch,
    diffStats,
    upstreamDiffStats: await resolveUpstreamDiffStats(git, currentBranch),
    localBranches: includeLocalBranches
      ? await getLocalBranchNames(git, summary)
      : [],
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
  private readonly projectWatchers = new Map<string, ProjectWatcherState>();
  private readonly handleProjectsStateUpdate = () => {
    if (this.disposed) {
      return;
    }

    this.syncProjectWatchers();
  };

  private refreshInFlight: Promise<void> | null = null;
  private disposed = false;
  private started = false;

  constructor(private readonly projectsState: ProjectState) {}

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.projectsState.eventTarget.addEventListener(
      "state-update",
      this.handleProjectsStateUpdate,
    );
    this.syncProjectWatchers();
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

  async getUncommittedDiff(projectPath: string): Promise<string | null> {
    try {
      const git = simpleGit(projectPath);
      const isRepo = await git.checkIsRepo();
      if (!isRepo) return null;
      const diffBaseRef = await resolveDiffBaseRef(git);
      const diff = await withTemporaryIndex(
        git,
        projectPath,
        async (tempGit) => {
          await tempGit.raw(["add", "-A"]);
          return await tempGit.raw(["diff", "--cached", diffBaseRef]);
        },
      );
      const trimmed = diff.trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }

  /**
   * Commits working-tree changes for the given paths only. Other staged
   * changes stay staged and are not included in this commit (git pathspec
   * commit semantics).
   */
  async commitSelectedChanges(
    projectPath: string,
    input: {
      paths: string[];
      subject: string;
      description?: string;
    },
  ): Promise<void> {
    const git = simpleGit(projectPath);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      throw new Error("Project is not a Git repository.");
    }

    const paths = [
      ...new Set(input.paths.map((p) => p.trim()).filter(Boolean)),
    ];
    if (paths.length === 0) {
      throw new Error("No files selected to commit.");
    }

    const subject = input.subject.trim();
    if (!subject) {
      throw new Error("Commit message is required.");
    }

    const description = input.description?.trim();
    const message = description ? [subject, description] : subject;

    try {
      await git.commit(message, paths);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Git commit failed.";
      throw new Error(msg);
    }

    await this.refreshProject(projectPath);
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

    const projectGitData = await readProjectGitData(projectPath, {
      includeLocalBranches: true,
    });
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

    const projectGitData = await readProjectGitData(sourcePath, {
      includeLocalBranches: true,
    });
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

  private syncProjectWatchers(): void {
    const trackedPaths = new Set(
      this.projectsState.state.map((project) => project.path),
    );

    for (const projectPath of trackedPaths) {
      this.ensureProjectWatcher(projectPath);
    }

    for (const [projectPath] of this.projectWatchers) {
      if (trackedPaths.has(projectPath)) {
        continue;
      }

      void this.disposeProjectWatcher(projectPath);
    }
  }

  private ensureProjectWatcher(projectPath: string): void {
    if (this.disposed || this.projectWatchers.has(projectPath)) {
      return;
    }

    const watcherState = {} as ProjectWatcherState;
    const watcher = chokidar.watch(".", {
      cwd: projectPath,
      ignoreInitial: true,
      ignored: (watchedPath) =>
        isGitignoredPath(
          normalizeWatchedRelativePath(watchedPath),
          watcherState.ignoredPaths,
        ),
    });

    watcherState.debounceTimer = null;
    watcherState.ignoredPaths = new Set();
    watcherState.ignoredPathsRefreshInFlight = null;
    watcherState.watcher = watcher;

    watcher.on("all", (_eventName, watchedPath) => {
      if (
        isGitignoredPath(
          normalizeWatchedRelativePath(watchedPath),
          watcherState.ignoredPaths,
        )
      ) {
        return;
      }

      this.scheduleProjectRefresh(projectPath, watcherState);
    });

    watcher.on("error", (error) => {
      if (this.disposed) {
        return;
      }

      log.warn("Project git watcher error", {
        projectPath,
        message: error instanceof Error ? error.message : String(error),
      });
    });

    this.projectWatchers.set(projectPath, watcherState);
    void this.refreshWatcherIgnoredPaths(projectPath, watcherState);
  }

  private scheduleProjectRefresh(
    projectPath: string,
    watcherState: ProjectWatcherState,
  ): void {
    if (watcherState.debounceTimer) {
      clearTimeout(watcherState.debounceTimer);
    }

    watcherState.debounceTimer = setTimeout(() => {
      watcherState.debounceTimer = null;
      void this.refreshWatchedProject(projectPath, watcherState);
    }, GIT_STATUS_WATCH_DEBOUNCE_MS);
  }

  private async refreshWatchedProject(
    projectPath: string,
    watcherState: ProjectWatcherState,
  ): Promise<void> {
    if (
      this.disposed ||
      this.projectWatchers.get(projectPath) !== watcherState ||
      !this.projectsState.state.some((project) => project.path === projectPath)
    ) {
      return;
    }

    try {
      await this.refreshWatcherIgnoredPaths(projectPath, watcherState);
      if (
        this.disposed ||
        this.projectWatchers.get(projectPath) !== watcherState
      ) {
        return;
      }

      await this.refreshProject(projectPath);
    } catch (error) {
      if (this.disposed) {
        return;
      }

      log.warn("Watched project git refresh failed", {
        projectPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private refreshWatcherIgnoredPaths(
    projectPath: string,
    watcherState: ProjectWatcherState,
  ): Promise<void> {
    if (watcherState.ignoredPathsRefreshInFlight) {
      return watcherState.ignoredPathsRefreshInFlight;
    }

    watcherState.ignoredPathsRefreshInFlight = (async () => {
      const ignoredPaths = await readGitignoredPaths(projectPath);
      if (this.projectWatchers.get(projectPath) !== watcherState) {
        return;
      }

      watcherState.ignoredPaths = ignoredPaths;
    })().finally(() => {
      if (this.projectWatchers.get(projectPath) === watcherState) {
        watcherState.ignoredPathsRefreshInFlight = null;
      }
    });

    return watcherState.ignoredPathsRefreshInFlight;
  }

  private async disposeProjectWatcher(projectPath: string): Promise<void> {
    const watcherState = this.projectWatchers.get(projectPath);
    if (!watcherState) {
      return;
    }

    this.projectWatchers.delete(projectPath);
    if (watcherState.debounceTimer) {
      clearTimeout(watcherState.debounceTimer);
      watcherState.debounceTimer = null;
    }

    await watcherState.watcher.close();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.started) {
      this.projectsState.eventTarget.removeEventListener(
        "state-update",
        this.handleProjectsStateUpdate,
      );
    }

    await Promise.allSettled(
      Array.from(this.projectWatchers.keys()).map(async (projectPath) =>
        this.disposeProjectWatcher(projectPath),
      ),
    );
  }
}
