import { randomUUID } from "node:crypto";
import { copyFile, cp, lstat, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ClaudeProject,
  GitDiffStats,
  GitHistoryCommit,
  GitHistoryPage,
  GitUpstreamDiffStats,
} from "@shared/claude-types";
import { autogenerateCommitPlaceholderSubject } from "@shared/commit-message-generation";
import {
  buildSuggestedWorktreePath,
  buildWorktreeBranchName,
  generatePlaceholderWorktreeSegment,
  sanitizeWorktreeBranchSegment,
  WORKTREE_BRANCH_PREFIX,
} from "@shared/project-worktree";
import simpleGit from "simple-git";
import log from "./logger";
import type { ProjectState } from "./project-service";
import {
  PROJECT_SETTINGS_DIR,
  type ProjectSettingsFile,
  writeProjectSettingsFile,
} from "./project-settings-file";
import { parseSetupCommands } from "./sessions/worktree-setup.session";
import { withThrottledAsyncRunner } from "./throttle-runner";

const EMPTY_GIT_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GIT_PROJECT_REFRESH_THROTTLE_MS = 3_000;
const SCRATCH_INDEX_PREFIX = "agent-ui-scratch-index-";
const WORKTREE_NAME_ATTEMPTS = 20;
const WORKTREE_ALIAS_MAX_LENGTH = 60;
const gitIndexPathCache = new Map<string, string>();

function createGit(
  projectPath: string,
  extraEnv?: Record<string, string>,
): ReturnType<typeof simpleGit> {
  return simpleGit(projectPath).env({
    ...process.env,
    LC_ALL: "C",
    ...extraEnv,
  });
}

const GIT_LOG_FIELD_SEPARATOR = "\x1f";
const GIT_LOG_RECORD_SEPARATOR = "\x1e";
const GIT_LOG_HISTORY_FORMAT = `${["%H", "%P", "%an", "%ae", "%aI", "%D", "%s", "%b"].join("%x1f")}%x1e`;
const GIT_COMMIT_HASH_PATTERN = /^[0-9a-f]{4,64}$/i;

function assertValidCommitHash(hash: string): void {
  if (!GIT_COMMIT_HASH_PATTERN.test(hash)) {
    throw new Error("Invalid commit hash.");
  }
}

export function formatGitPushError(raw: string): string {
  const text = raw.trim();
  if (!text) {
    return "Git push failed.";
  }

  const lower = text.toLowerCase();

  if (
    lower.includes("fetch first") ||
    lower.includes("non-fast-forward") ||
    lower.includes("remote contains work that you do not")
  ) {
    return "Push rejected: remote has new commits. Pull or rebase, then push again.";
  }

  if (
    lower.includes("could not read username") ||
    lower.includes("authentication failed") ||
    lower.includes("auth_header") ||
    lower.includes("permission denied (publickey)") ||
    lower.includes("invalid username or password")
  ) {
    return "Push failed: authentication required. Check your Git credentials.";
  }

  if (
    lower.includes("protected branch") ||
    lower.includes("gh006") ||
    lower.includes("cannot push to a protected")
  ) {
    return "Push rejected: this branch is protected on the remote.";
  }

  if (
    lower.includes("does not appear to be a git repository") ||
    (lower.includes("repository") && lower.includes("not found"))
  ) {
    return "Push failed: remote repository not found or inaccessible.";
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^(error|fatal|remote):/i.test(trimmed)) {
      return trimmed;
    }
  }

  return "Git push failed.";
}

export function formatGitPullError(raw: string): string {
  const text = raw.trim();
  if (!text) {
    return "Git pull failed.";
  }

  const lower = text.toLowerCase();

  if (
    lower.includes("not possible to fast-forward") ||
    lower.includes("cannot fast-forward") ||
    lower.includes("diverging branches") ||
    lower.includes("divergent branches") ||
    lower.includes("need to specify how to reconcile")
  ) {
    return "Pull stopped: local and remote have diverged. Rebase or merge in a terminal.";
  }

  if (
    lower.includes("would be overwritten by merge") ||
    lower.includes(
      "local changes to the following files would be overwritten",
    ) ||
    lower.includes("please commit your changes or stash them")
  ) {
    return "Pull stopped: local changes would be overwritten. Commit or stash them first.";
  }

  if (
    lower.includes("could not read username") ||
    lower.includes("authentication failed") ||
    lower.includes("auth_header") ||
    lower.includes("permission denied (publickey)") ||
    lower.includes("invalid username or password")
  ) {
    return "Pull failed: authentication required. Check your Git credentials.";
  }

  if (
    lower.includes("couldn't find remote ref") ||
    lower.includes("could not find remote ref")
  ) {
    return "Pull failed: the upstream branch no longer exists on the remote.";
  }

  if (
    lower.includes("does not appear to be a git repository") ||
    (lower.includes("repository") && lower.includes("not found"))
  ) {
    return "Pull failed: remote repository not found or inaccessible.";
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^(error|fatal|remote):/i.test(trimmed)) {
      return trimmed;
    }
  }

  return "Git pull failed.";
}

function parseCommitHistoryOutput(
  output: string,
): Omit<GitHistoryCommit, "unpushed">[] {
  const commits: Omit<GitHistoryCommit, "unpushed">[] = [];

  for (const record of output.split(GIT_LOG_RECORD_SEPARATOR)) {
    const trimmedRecord = record.trim();
    if (!trimmedRecord) {
      continue;
    }

    const fields = trimmedRecord.split(GIT_LOG_FIELD_SEPARATOR);
    if (fields.length < 8) {
      continue;
    }

    const [
      hash,
      parents,
      authorName,
      authorEmail,
      authorDate,
      refs,
      subject,
      ...bodyParts
    ] = fields;
    if (!hash) {
      continue;
    }

    commits.push({
      hash,
      parentHashes: parents.split(/\s+/).filter(Boolean),
      authorName,
      authorEmail,
      authorDate,
      refs: refs
        .split(",")
        .map((ref) => ref.trim())
        .filter(Boolean),
      subject: subject.trim(),
      body: bodyParts.join(GIT_LOG_FIELD_SEPARATOR).trim(),
    });
  }

  return commits;
}

function parseRevListHashes(output: string): Set<string> {
  return new Set(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

async function resolveUnpushedCommitHashes(
  git: ReturnType<typeof simpleGit>,
): Promise<Set<string> | null> {
  try {
    const output = await git.raw(["rev-list", "@{upstream}..HEAD"]);
    return parseRevListHashes(output);
  } catch {
    try {
      const output = await git.raw([
        "rev-list",
        "HEAD",
        "--not",
        "--remotes=origin",
      ]);
      return parseRevListHashes(output);
    } catch {
      return null;
    }
  }
}

async function resolveUnpushedCommitSubjects(
  git: ReturnType<typeof simpleGit>,
  hasUpstream: boolean,
): Promise<string[]> {
  const logArgs = hasUpstream
    ? ["log", "--format=%s", "@{upstream}..HEAD"]
    : ["log", "--format=%s", "HEAD", "--not", "--remotes=origin"];

  const output = await git.raw(logArgs);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function assertNoAutogeneratePlaceholderInUnpushedCommits(
  git: ReturnType<typeof simpleGit>,
  hasUpstream: boolean,
): Promise<void> {
  let subjects: string[];
  try {
    subjects = await resolveUnpushedCommitSubjects(git, hasUpstream);
  } catch {
    return;
  }

  if (!subjects.includes(autogenerateCommitPlaceholderSubject)) {
    return;
  }

  throw new Error(
    `Push rejected: unpushed history still contains "${autogenerateCommitPlaceholderSubject}". Amend those commits before pushing.`,
  );
}

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

export interface WorktreeStatus {
  path: string;
  branch: string | null;
  upstreamBranch: string | null;
  merged: boolean;
}

export interface WorktreeStatusOverview {
  originBranch: string | null;
  statuses: WorktreeStatus[];
}

async function readCurrentBranchName(
  git: ReturnType<typeof simpleGit>,
): Promise<string | null> {
  const branch = await git
    .raw(["rev-parse", "--abbrev-ref", "HEAD"])
    .then((output) => output.trim())
    .catch(() => "");

  return branch && branch !== "HEAD" ? branch : null;
}

async function readWorktreeBranches(
  git: ReturnType<typeof simpleGit>,
): Promise<Map<string, string>> {
  const branchByPath = new Map<string, string>();
  const output = await git
    .raw(["worktree", "list", "--porcelain"])
    .catch(() => "");

  let currentPath: string | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
      continue;
    }
    if (currentPath && line.startsWith("branch refs/heads/")) {
      branchByPath.set(currentPath, line.slice("branch refs/heads/".length));
      currentPath = null;
    }
  }

  return branchByPath;
}

async function readBranchUpstreams(
  git: ReturnType<typeof simpleGit>,
): Promise<Map<string, string>> {
  const upstreamByBranch = new Map<string, string>();
  const output = await git
    .raw([
      "for-each-ref",
      "--format=%(refname:short)\t%(upstream:short)",
      "refs/heads",
    ])
    .catch(() => "");

  for (const line of output.split("\n")) {
    const [branch, upstream] = line.split("\t");
    if (branch?.trim() && upstream?.trim()) {
      upstreamByBranch.set(branch.trim(), upstream.trim());
    }
  }

  return upstreamByBranch;
}

async function readMergedBranchNames(
  git: ReturnType<typeof simpleGit>,
  target: string,
): Promise<Set<string>> {
  const output = await git
    .raw(["branch", "--merged", target, "--format=%(refname:short)"])
    .catch(() => "");

  return new Set(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

async function listLocalBranchNames(
  git: ReturnType<typeof simpleGit>,
): Promise<string[]> {
  const output = await git.raw(["branch", "--format=%(refname:short)"]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
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

async function copyProjectSettingsDirectory(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  try {
    await cp(
      path.join(sourcePath, PROJECT_SETTINGS_DIR),
      path.join(destinationPath, PROJECT_SETTINGS_DIR),
      { recursive: true, force: false, errorOnExist: false },
    );
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException;
    if (fsError?.code === "ENOENT") {
      return;
    }

    log.warn(
      `Failed to copy ${PROJECT_SETTINGS_DIR} from ${sourcePath} to ${destinationPath}:`,
      error,
    );
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

async function resolveUpstreamBranchName(
  git: ReturnType<typeof simpleGit>,
): Promise<string | null> {
  try {
    const upstreamBranch = (
      await git.raw([
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ])
    ).trim();
    return upstreamBranch || null;
  } catch {
    return null;
  }
}

async function countCommitsSince(
  git: ReturnType<typeof simpleGit>,
  baseCommitHash: string,
): Promise<number> {
  if (!baseCommitHash) {
    return 0;
  }

  try {
    const output = await git.raw([
      "rev-list",
      "--count",
      `${baseCommitHash}..HEAD`,
    ]);
    const count = Number.parseInt(output.trim(), 10);
    return Number.isFinite(count) ? count : 0;
  } catch {
    return 0;
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

async function getPathsToStage({
  git,
  projectPath,
  paths,
}: {
  git: ReturnType<typeof simpleGit>;
  projectPath: string;
  paths: string[];
}): Promise<string[]> {
  const deleted = new Set(
    (
      await git.raw([
        "diff",
        "--cached",
        "--name-only",
        "--diff-filter=D",
        "--no-renames",
        "-z",
      ])
    ).split("\0"),
  );
  const stageable = await Promise.all(
    paths.map(async (filePath) => {
      if (!deleted.has(filePath)) return true;
      try {
        await lstat(path.resolve(projectPath, filePath));
        return true;
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return false;
        }
        throw error;
      }
    }),
  );
  return paths.filter((_, index) => stageable[index]);
}

async function withTemporaryIndex<T>(
  git: ReturnType<typeof simpleGit>,
  projectPath: string,
  operation: (tempGit: ReturnType<typeof simpleGit>) => Promise<T>,
): Promise<T> {
  const now = performance.now();
  const scratchIndexPath = await createScratchIndexCopy(git, projectPath);

  try {
    const tempGit = createGit(projectPath, {
      GIT_INDEX_FILE: scratchIndexPath,
    });
    const result = await operation(tempGit);
    return result;
  } finally {
    removeScratchIndex(scratchIndexPath);

    const duration = performance.now() - now;
    log.info("withTemporaryIndex duration", { duration });
  }
}

function removeScratchIndex(scratchIndexPath: string): void {
  void Promise.all([
    rm(scratchIndexPath, { force: true }),
    rm(`${scratchIndexPath}.lock`, { force: true }),
  ]).catch((error) => {
    log.warn("Failed to remove scratch git index", { scratchIndexPath, error });
  });
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

async function createScratchIndexCopy(
  git: ReturnType<typeof simpleGit>,
  projectPath: string,
): Promise<string> {
  const scratchFileName = `${SCRATCH_INDEX_PREFIX}${randomUUID()}`;
  const buildScratchIndexPath = (gitIndexPath: string) =>
    path.join(path.dirname(gitIndexPath), scratchFileName);

  const cachedGitIndexPath = await resolveGitIndexPath(git, projectPath);
  const cachedScratchIndexPath = buildScratchIndexPath(cachedGitIndexPath);

  try {
    await copyFile(cachedGitIndexPath, cachedScratchIndexPath);
    return cachedScratchIndexPath;
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException;
    if (fsError.code !== "ENOENT") {
      throw error;
    }
  }

  gitIndexPathCache.delete(projectPath);
  const resolvedGitIndexPath = await resolveGitIndexPath(git, projectPath, {
    bypassCache: true,
  });
  const scratchIndexPath = buildScratchIndexPath(resolvedGitIndexPath);

  try {
    await copyFile(resolvedGitIndexPath, scratchIndexPath);
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException;
    if (fsError.code !== "ENOENT") {
      throw error;
    }

    await writeFile(scratchIndexPath, "");
  }

  return scratchIndexPath;
}

async function readProjectGitData(
  projectPath: string,
  options?: {
    includeLocalBranches?: boolean;
  },
): Promise<ProjectGitData> {
  const includeLocalBranches = options?.includeLocalBranches ?? false;
  const git = createGit(projectPath);
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
    worktreeSetupCommands: project?.worktreeSetupCommands,
  };
}

function hasProjectSettings(settings: ProjectSettingsFile): boolean {
  return Boolean(settings.worktreeSetupCommands);
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

export type PullFromRemoteResult = {
  upstreamBranch: string;
  pulledCommits: number;
};

export type PerformDeleteWorktreeFolderResult = {
  warning?: string;
};

async function isWorktreeWorkingTreeClean(
  worktreePath: string,
): Promise<boolean> {
  const worktreeGit = createGit(worktreePath);
  const porcelain = await worktreeGit.raw(["status", "--porcelain"]);
  return porcelain.trim().length === 0;
}

export class ProjectGitService {
  private readonly refreshRunners = new Map<
    string,
    ReturnType<typeof withThrottledAsyncRunner>
  >();

  private refreshInFlight: Promise<void> | null = null;
  private disposed = false;
  private started = false;

  constructor(private readonly projectsState: ProjectState) {}

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.triggerRefresh();
  }

  refreshProject(projectPath: string): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }

    return this.getRefreshRunner(projectPath).schedule();
  }

  private getRefreshRunner(projectPath: string) {
    const existingRunner = this.refreshRunners.get(projectPath);
    if (existingRunner) {
      return existingRunner;
    }

    const runner = withThrottledAsyncRunner(
      () => this.refreshProjectNow(projectPath),
      GIT_PROJECT_REFRESH_THROTTLE_MS,
      { leading: true, trailing: true },
    );
    this.refreshRunners.set(projectPath, runner);
    return runner;
  }

  private async refreshProjectNow(projectPath: string): Promise<void> {
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
    return this.getChangesDiff(projectPath);
  }

  async getSelectedChangesDiff(
    projectPath: string,
    paths: string[],
  ): Promise<string | null> {
    const uniquePaths = [
      ...new Set(paths.map((p) => p.trim()).filter(Boolean)),
    ];
    if (uniquePaths.length === 0) {
      return null;
    }

    return this.getChangesDiff(projectPath, uniquePaths);
  }

  private async getChangesDiff(
    projectPath: string,
    paths?: string[],
  ): Promise<string | null> {
    try {
      const git = createGit(projectPath);
      const isRepo = await git.checkIsRepo();
      if (!isRepo) return null;
      const diffBaseRef = await resolveDiffBaseRef(git);
      const diff = await withTemporaryIndex(
        git,
        projectPath,
        async (tempGit) => {
          if (paths) {
            const pathsToStage = await getPathsToStage({
              git: tempGit,
              projectPath,
              paths,
            });
            if (pathsToStage.length > 0) {
              await tempGit.raw(["add", "-A", "--", ...pathsToStage]);
            }
            return await tempGit.raw([
              "diff",
              "--cached",
              diffBaseRef,
              "--",
              ...paths,
            ]);
          }

          await tempGit.raw(["add", "-A"]);
          return await tempGit.raw(["diff", "--cached", diffBaseRef]);
        },
      );
      const trimmed = diff.trim();
      return trimmed || null;
    } catch (error) {
      log.error("Failed to read changes diff", { projectPath, paths, error });
      throw error;
    }
  }

  async commitSelectedChanges(
    projectPath: string,
    input: {
      paths: string[];
      subject: string;
      description?: string;
    },
  ): Promise<void> {
    const git = createGit(projectPath);
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
      const pathsToStage = await getPathsToStage({ git, projectPath, paths });
      if (pathsToStage.length > 0) {
        await git.add(pathsToStage);
      }
      await git.commit(message, paths);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Git commit failed.";
      throw new Error(msg);
    }

    await this.refreshProject(projectPath);
  }

  async getCommitHistory(
    projectPath: string,
    input: {
      cursor?: string;
      limit: number;
    },
  ): Promise<GitHistoryPage> {
    const emptyPage: GitHistoryPage = { commits: [], nextCursor: null };

    const git = createGit(projectPath);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      return emptyPage;
    }

    try {
      await git.raw(["rev-parse", "--verify", "HEAD"]);
    } catch {
      return emptyPage;
    }

    const cursor = input.cursor?.trim();
    if (cursor) {
      assertValidCommitHash(cursor);
    }

    const logArgs = [
      "log",
      `--format=${GIT_LOG_HISTORY_FORMAT}`,
      `--max-count=${input.limit + 1}`,
    ];
    if (cursor) {
      logArgs.push("--skip=1", cursor);
    } else {
      logArgs.push("HEAD");
    }

    const [output, unpushedHashes] = await Promise.all([
      git.raw(logArgs),
      resolveUnpushedCommitHashes(git),
    ]);
    const entries = parseCommitHistoryOutput(output);
    const hasMore = entries.length > input.limit;
    const trimmedEntries = hasMore ? entries.slice(0, input.limit) : entries;
    const commits = trimmedEntries.map((entry) => ({
      ...entry,
      unpushed: unpushedHashes?.has(entry.hash) ?? false,
    }));
    const lastCommit = commits.at(-1);

    return {
      commits,
      nextCursor: hasMore && lastCommit ? lastCommit.hash : null,
    };
  }

  async pushToRemote(projectPath: string): Promise<void> {
    const git = createGit(projectPath, { GIT_TERMINAL_PROMPT: "0" });
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      throw new Error("Project is not a Git repository.");
    }

    const branch = (
      await git.raw(["symbolic-ref", "--short", "HEAD"]).catch(() => "")
    ).trim();
    if (!branch) {
      throw new Error("Cannot push from a detached HEAD.");
    }

    const upstreamBranch = await resolveUpstreamBranchName(git);
    await assertNoAutogeneratePlaceholderInUnpushedCommits(
      git,
      Boolean(upstreamBranch),
    );

    try {
      if (upstreamBranch) {
        await git.push();
      } else {
        await git.push(["--set-upstream", "origin", branch]);
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : "";
      throw new Error(formatGitPushError(raw));
    }

    await this.refreshProject(projectPath);
  }

  async pullFromRemote(projectPath: string): Promise<PullFromRemoteResult> {
    const git = createGit(projectPath, { GIT_TERMINAL_PROMPT: "0" });
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      throw new Error("Project is not a Git repository.");
    }

    const branch = (
      await git.raw(["symbolic-ref", "--short", "HEAD"]).catch(() => "")
    ).trim();
    if (!branch) {
      throw new Error("Cannot pull into a detached HEAD.");
    }

    const upstreamBranch = await resolveUpstreamBranchName(git);
    if (!upstreamBranch) {
      throw new Error(
        "No upstream branch is configured. Publish the branch first, then pull.",
      );
    }

    const previousHead = (
      await git.raw(["rev-parse", "HEAD"]).catch(() => "")
    ).trim();

    try {
      await git.raw(["pull", "--ff-only"]);
    } catch (error) {
      const raw = error instanceof Error ? error.message : "";
      throw new Error(formatGitPullError(raw));
    }

    const pulledCommits = await countCommitsSince(git, previousHead);

    await this.refreshProject(projectPath);

    return { upstreamBranch, pulledCommits };
  }

  async getCommitDiff(
    projectPath: string,
    commitHash: string,
  ): Promise<string | null> {
    const git = createGit(projectPath);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      throw new Error("Project is not a Git repository.");
    }

    const hash = commitHash.trim();
    assertValidCommitHash(hash);

    let parentRef: string;
    try {
      parentRef =
        (await git.raw(["rev-parse", "--verify", `${hash}^`])).trim() ||
        EMPTY_GIT_TREE_HASH;
    } catch {
      parentRef = EMPTY_GIT_TREE_HASH;
    }

    const diff = await git.raw(["diff", "--no-color", parentRef, hash]);
    const trimmed = diff.trim();
    return trimmed || null;
  }

  async getLastCommitDiff(
    projectPath: string,
    paths: string[],
  ): Promise<string | null> {
    const git = createGit(projectPath);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      throw new Error("Project is not a Git repository.");
    }

    const uniquePaths = [
      ...new Set(paths.map((p) => p.trim()).filter(Boolean)),
    ];
    if (uniquePaths.length === 0) {
      return null;
    }

    try {
      const diff = await git.raw([
        "show",
        "--pretty=format:",
        "--no-color",
        "HEAD",
        "--",
        ...uniquePaths,
      ]);
      const trimmed = diff.trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }

  async amendLastCommitMessage(
    projectPath: string,
    input: {
      subject: string;
      description?: string;
    },
  ): Promise<void> {
    const git = createGit(projectPath);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      throw new Error("Project is not a Git repository.");
    }

    const subject = input.subject.trim();
    if (!subject) {
      throw new Error("Commit message is required.");
    }

    const description = input.description?.trim();
    const message = description ? [subject, description] : subject;

    try {
      await git.commit(message, [], { "--amend": null });
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "Failed to amend commit.";
      throw new Error(msg);
    }

    await this.refreshProject(projectPath);
  }

  async undoLastCommit(projectPath: string): Promise<void> {
    const git = createGit(projectPath);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      throw new Error("Project is not a Git repository.");
    }

    const branch = (
      await git.raw(["symbolic-ref", "--short", "HEAD"]).catch(() => "")
    ).trim();
    if (!branch) {
      throw new Error("Cannot undo commit from a detached HEAD.");
    }

    const head = (await git.raw(["rev-parse", "HEAD"]).catch(() => "")).trim();
    if (!head) {
      throw new Error("Cannot undo commit: this branch has no commits.");
    }

    const parents = (
      await git.raw(["log", "-1", "--format=%P", "HEAD"]).catch(() => "")
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (parents.length === 0) {
      throw new Error("Cannot undo the only commit on this branch.");
    }
    if (parents.length > 1) {
      throw new Error("Cannot undo a merge commit.");
    }

    const unpushedHashes = await resolveUnpushedCommitHashes(git);
    if (!unpushedHashes?.has(head)) {
      throw new Error(
        "Cannot undo commit: the latest commit has already been pushed.",
      );
    }

    try {
      await git.raw(["reset", "--soft", "HEAD~1"]);
    } catch (error) {
      const msg =
        error instanceof Error && error.message.trim()
          ? error.message
          : "Failed to undo commit.";
      throw new Error(msg);
    }

    await this.refreshProject(projectPath);
  }

  async discardChanges(projectPath: string, paths: string[]): Promise<void> {
    const git = createGit(projectPath);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      throw new Error("Project is not a Git repository.");
    }

    const uniquePaths = [
      ...new Set(paths.map((p) => p.trim()).filter(Boolean)),
    ];
    if (uniquePaths.length === 0) {
      throw new Error("No files selected to discard.");
    }

    const diffBaseRef = await resolveDiffBaseRef(git);
    const headOutput = await git.raw([
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      diffBaseRef,
      "--",
      ...uniquePaths,
    ]);
    const pathsInHead = new Set(headOutput.split("\0").filter(Boolean));
    const restorePaths = uniquePaths.filter((p) => pathsInHead.has(p));
    const deletePaths = uniquePaths.filter((p) => !pathsInHead.has(p));

    try {
      await git.raw(["reset", "-q", diffBaseRef, "--", ...uniquePaths]);
      if (restorePaths.length > 0) {
        await git.raw(["checkout", diffBaseRef, "--", ...restorePaths]);
      }
      const projectRoot = path.resolve(projectPath);
      await Promise.all(
        deletePaths.map((relativePath) => {
          const targetPath = path.resolve(projectRoot, relativePath);
          if (
            targetPath !== projectRoot &&
            !targetPath.startsWith(`${projectRoot}${path.sep}`)
          ) {
            throw new Error(
              `Refusing to delete path outside project: ${relativePath}`,
            );
          }
          return rm(targetPath, {
            force: true,
            recursive: true,
          });
        }),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Discard failed.";
      throw new Error(msg);
    }

    await this.refreshProject(projectPath);
  }

  async getWorktreeStatuses(
    originPath: string,
  ): Promise<WorktreeStatusOverview> {
    const trimmedOriginPath = originPath.trim();
    const worktreeProjects = this.projectsState.state.filter(
      (project) => project.worktreeOriginPath === trimmedOriginPath,
    );

    const fallback: WorktreeStatusOverview = {
      originBranch: null,
      statuses: worktreeProjects.map((project) => ({
        path: project.path,
        branch: project.gitBranch ?? null,
        upstreamBranch: null,
        merged: false,
      })),
    };

    const git = createGit(trimmedOriginPath);
    if (!(await git.checkIsRepo().catch(() => false))) {
      return fallback;
    }

    const originBranch = await readCurrentBranchName(git);
    const [branchByWorktreePath, upstreamByBranch, mergedBranches] =
      await Promise.all([
        readWorktreeBranches(git),
        readBranchUpstreams(git),
        originBranch
          ? readMergedBranchNames(git, originBranch)
          : new Set<string>(),
      ]);

    const statuses = worktreeProjects.map((project) => {
      const branch =
        branchByWorktreePath.get(project.path) ?? project.gitBranch ?? null;

      return {
        path: project.path,
        branch,
        upstreamBranch: branch ? (upstreamByBranch.get(branch) ?? null) : null,
        merged: branch ? mergedBranches.has(branch) : false,
      };
    });

    return { originBranch, statuses };
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

    return this.registerWorktreeProject({
      sourcePath,
      destinationPath,
      alias,
    });
  }

  async createSessionWorktree(input: {
    sourcePath: string;
    name?: string;
  }): Promise<{
    path: string;
    projectRoot: string;
    worktreeRoot: string;
    setupCommands: string[];
  }> {
    const sourcePath = input.sourcePath.trim();
    if (!sourcePath) {
      throw new Error("Source path is required.");
    }

    const sourceProject = this.projectsState.state.find(
      (project) => project.path === sourcePath,
    );
    if (sourceProject?.worktreeOriginPath) {
      throw new Error(
        "Cannot create a worktree from a project that is itself a worktree.",
      );
    }

    const projectGitData = await readProjectGitData(sourcePath, {
      includeLocalBranches: true,
    });
    if (!projectGitData.isRepo) {
      throw new Error("Project is not a Git repository.");
    }

    const fromBranch = getDefaultWorktreeBranch(projectGitData);
    const requestedSegment = sanitizeWorktreeBranchSegment(input.name ?? "");
    const isPlaceholder = requestedSegment.length === 0;
    const target = await this.resolveAvailableWorktreeTarget({
      sourcePath,
      segment: isPlaceholder
        ? generatePlaceholderWorktreeSegment()
        : requestedSegment,
      localBranches: projectGitData.localBranches,
    });

    await projectGitData.git.raw([
      "worktree",
      "add",
      "-b",
      target.branch,
      target.destinationPath,
      fromBranch,
    ]);

    return this.registerWorktreeProject({
      sourcePath,
      destinationPath: target.destinationPath,
      placeholder: isPlaceholder,
    });
  }

  async renamePlaceholderWorktree(input: {
    worktreePath: string;
    title: string;
  }): Promise<void> {
    const project = this.projectsState.state.find(
      (item) => item.path === input.worktreePath,
    );
    if (!project?.worktreePlaceholder || !project.worktreeOriginPath) {
      return;
    }

    const title = input.title.trim();
    const segment = sanitizeWorktreeBranchSegment(title);
    if (!segment) {
      this.clearWorktreePlaceholder(input.worktreePath);
      return;
    }

    let renamedBranch: string | undefined;
    try {
      renamedBranch = await this.renamePlaceholderBranch(
        input.worktreePath,
        segment,
      );
    } catch (error) {
      log.warn("Failed to rename placeholder worktree branch", {
        worktreePath: input.worktreePath,
        error,
      });
    }

    if (this.disposed) {
      return;
    }

    this.projectsState.updateState((projects) => {
      const draft = projects.find((item) => item.path === input.worktreePath);
      if (!draft) {
        return;
      }
      draft.worktreePlaceholder = undefined;
      draft.alias =
        draft.alias?.trim() || title.slice(0, WORKTREE_ALIAS_MAX_LENGTH);
      if (renamedBranch) {
        draft.gitBranch = renamedBranch;
      }
    });

    if (renamedBranch) {
      await this.refreshProject(input.worktreePath);
    }
  }

  private async renamePlaceholderBranch(
    worktreePath: string,
    segment: string,
  ): Promise<string | undefined> {
    const git = createGit(worktreePath);
    const currentBranch = (
      await git.raw(["rev-parse", "--abbrev-ref", "HEAD"])
    ).trim();

    if (!currentBranch.startsWith(WORKTREE_BRANCH_PREFIX)) {
      return undefined;
    }

    const upstreamByBranch = await readBranchUpstreams(git);
    if (upstreamByBranch.has(currentBranch)) {
      return undefined;
    }

    const localBranches = await listLocalBranchNames(git);
    for (let attempt = 0; attempt < WORKTREE_NAME_ATTEMPTS; attempt++) {
      const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
      const nextBranch = buildWorktreeBranchName(`${segment}${suffix}`);
      if (nextBranch === currentBranch) {
        return undefined;
      }
      if (localBranches.includes(nextBranch)) {
        continue;
      }

      await git.raw(["branch", "-m", currentBranch, nextBranch]);
      return nextBranch;
    }

    return undefined;
  }

  private clearWorktreePlaceholder(worktreePath: string): void {
    if (this.disposed) {
      return;
    }

    this.projectsState.updateState((projects) => {
      const draft = projects.find((item) => item.path === worktreePath);
      if (draft) {
        draft.worktreePlaceholder = undefined;
      }
    });
  }

  private async resolveAvailableWorktreeTarget(input: {
    sourcePath: string;
    segment: string;
    localBranches: string[];
  }): Promise<{ branch: string; destinationPath: string }> {
    for (let attempt = 0; attempt < WORKTREE_NAME_ATTEMPTS; attempt++) {
      const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
      const branch = buildWorktreeBranchName(`${input.segment}${suffix}`);
      const destinationPath = buildSuggestedWorktreePath(
        input.sourcePath,
        `${input.segment}${suffix}`,
      );

      if (
        input.localBranches.includes(branch) ||
        this.projectsState.state.some(
          (project) => project.path === destinationPath,
        ) ||
        (await isExistingNonEmptyPath(destinationPath))
      ) {
        continue;
      }

      return { branch, destinationPath };
    }

    throw new Error("Could not find an unused worktree name.");
  }

  private async registerWorktreeProject(input: {
    sourcePath: string;
    destinationPath: string;
    alias?: string;
    placeholder?: boolean;
  }): Promise<{
    path: string;
    projectRoot: string;
    worktreeRoot: string;
    setupCommands: string[];
  }> {
    const { sourcePath, destinationPath } = input;
    const sourceProject = this.projectsState.state.find(
      (project) => project.path === sourcePath,
    );

    await copyProjectSettingsDirectory(sourcePath, destinationPath);

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
          alias: input.alias,
          worktreeOriginPath: sourcePath,
          worktreePlaceholder: input.placeholder ? true : undefined,
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

  async performDeleteWorktreeFolderAndBranch(input: {
    path: string;
    deleteFolder: boolean;
    deleteBranch: boolean;
    forceDeleteFolder: boolean;
    forceDeleteBranch?: boolean;
  }): Promise<PerformDeleteWorktreeFolderResult> {
    const projectPath = input.path.trim();
    const project = this.projectsState.state.find(
      (item) => item.path === projectPath,
    );

    this.assertDeleteWorktreeProjectInput(input, project);

    if (!input.deleteFolder) {
      return {};
    }

    const sourceGit = createGit(project.worktreeOriginPath);
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
      await sourceGit.raw([
        "branch",
        input.forceDeleteBranch ? "-D" : "-d",
        project.gitBranch,
      ]);
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

  async dispose(): Promise<void> {
    this.disposed = true;

    await Promise.allSettled(
      Array.from(this.refreshRunners.values()).map((runner) => runner.flush()),
    );

    for (const runner of this.refreshRunners.values()) {
      runner.dispose();
    }
    this.refreshRunners.clear();
  }
}
