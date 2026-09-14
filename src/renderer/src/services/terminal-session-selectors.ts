import type { Session } from "@main/sessions/state";
import type { ClaudeProject, GitUpstreamDiffStats } from "@shared/claude-types";
import { isSessionSettled } from "@shared/session-lifecycle";

export interface ProjectSessionGroup {
  path: string;
  displayName: string;
  collapsed: boolean;
  hidden: boolean;
  fromProjectList: boolean;
  gitBranch?: string;
  gitUpstreamDiffStats?: GitUpstreamDiffStats;
  isWorktree: boolean;
  worktreeOriginName?: string;
  worktreeOriginPath?: string;
  worktreeCount: number;
  interactionDisabled: boolean;
  sessions: Session[];
}

interface BuildProjectSessionGroupsInput {
  projects: ClaudeProject[];
  sessionsById: Record<string, Session>;
}

function compareSessionsByCreatedAtDesc(a: Session, b: Session): number {
  return b.createdAt - a.createdAt;
}

export function getProjectNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);

  return segments[segments.length - 1] ?? path;
}

export function getProjectDisplayName(project: {
  path: string;
  alias?: string;
}): string {
  const baseName = getProjectNameFromPath(project.path);
  const alias = project.alias?.trim();

  return alias ? `${alias} (${baseName})` : baseName;
}

export function getSessionLastActivityLabel(
  session: Session,
  now = Date.now(),
): string {
  const timestamp = session.lastActivityAt;
  if (timestamp <= 0) {
    return "";
  }

  const deltaSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (deltaSeconds < 60) {
    const roundedSeconds = Math.round(deltaSeconds / 10) * 10;
    if (roundedSeconds <= 0) {
      return "now";
    }
    if (roundedSeconds >= 60) {
      return "1m";
    }
    return `${roundedSeconds}s`;
  }

  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d`;
  }

  const weeks = Math.floor(days / 7);
  if (weeks < 5) {
    return `${weeks}w`;
  }

  const months = Math.floor(days / 30);
  if (months < 12 || days < 365) {
    return `${months}mo`;
  }

  return `${Math.floor(days / 365)}y`;
}

export function getVisibleSessionIds(groups: ProjectSessionGroup[]): string[] {
  const ids: string[] = [];
  for (const group of groups) {
    if (group.collapsed) continue;
    for (const session of group.sessions) {
      ids.push(session.sessionId);
    }
  }
  return ids;
}

export function isAwaitingUserInputStatus(status: string): boolean {
  return (
    status === "awaiting_user_response" || status === "awaiting_user_reply"
  );
}

export function groupHasAwaitingUserInput(
  group: Pick<ProjectSessionGroup, "sessions">,
): boolean {
  return group.sessions.some((session) =>
    isAwaitingUserInputStatus(session.status),
  );
}

export interface ProjectTreeWorktree {
  path: string;
  label: string;
  disabled: boolean;
}

export interface ProjectTreeNode {
  path: string;
  label: string;
  branch?: string;
  hidden: boolean;
  disabled: boolean;
  unlisted: boolean;
  canCreateWorktree: boolean;
  worktrees: ProjectTreeWorktree[];
}

export function getWorktreeDisplayName(project: ClaudeProject): string {
  return (
    project.alias?.trim() ||
    project.gitBranch?.trim() ||
    getProjectNameFromPath(project.path)
  );
}

export function buildProjectTree(input: {
  projects: ClaudeProject[];
  selectedPath: string;
}): ProjectTreeNode[] {
  const nodesByPath = new Map<string, ProjectTreeNode>();
  const nodes: ProjectTreeNode[] = [];

  const addNode = (project: ClaudeProject, isWorktree: boolean) => {
    const node: ProjectTreeNode = {
      path: project.path,
      label: isWorktree
        ? getWorktreeDisplayName(project)
        : getProjectDisplayName(project),
      branch: project.gitBranch,
      hidden: project.hidden === true,
      disabled: project.interactionDisabled === true,
      unlisted: false,
      canCreateWorktree:
        !isWorktree &&
        Boolean(project.gitBranch) &&
        project.interactionDisabled !== true,
      worktrees: [],
    };
    nodesByPath.set(node.path, node);
    nodes.push(node);
  };

  for (const project of input.projects) {
    if (!project.worktreeOriginPath) {
      addNode(project, false);
    }
  }

  for (const project of input.projects) {
    if (!project.worktreeOriginPath) {
      continue;
    }

    const origin = nodesByPath.get(project.worktreeOriginPath);
    if (!origin) {
      addNode(project, true);
      continue;
    }

    origin.worktrees.push({
      path: project.path,
      label: getWorktreeDisplayName(project),
      disabled: project.interactionDisabled === true,
    });
  }

  const selectedPath = input.selectedPath.trim();
  if (
    !selectedPath ||
    input.projects.some((project) => project.path === selectedPath)
  ) {
    return nodes;
  }

  return [
    {
      path: selectedPath,
      label: getProjectNameFromPath(selectedPath),
      hidden: false,
      disabled: false,
      unlisted: true,
      canCreateWorktree: false,
      worktrees: [],
    },
    ...nodes,
  ];
}

export type ProjectSelection =
  | { kind: "project"; path: string }
  | { kind: "new-worktree"; originPath: string };

export interface ProjectSelectionDisplay {
  faviconPath: string;
  label: string;
  detail: string | null;
}

export function getProjectSelectionOriginPath(value: ProjectSelection): string {
  return value.kind === "project" ? value.path : value.originPath;
}

export function resolveProjectSelectionDisplay(
  nodes: ProjectTreeNode[],
  value: ProjectSelection,
): ProjectSelectionDisplay | null {
  if (value.kind === "new-worktree") {
    const origin = nodes.find((node) => node.path === value.originPath);
    return origin
      ? {
          faviconPath: origin.path,
          label: origin.label,
          detail: "New worktree",
        }
      : null;
  }

  for (const node of nodes) {
    if (node.path === value.path) {
      return { faviconPath: node.path, label: node.label, detail: null };
    }

    const worktree = node.worktrees.find((item) => item.path === value.path);
    if (worktree) {
      return {
        faviconPath: node.path,
        label: node.label,
        detail: worktree.label,
      };
    }
  }

  return null;
}

export function projectTreeNodeHoldsSelection(
  node: ProjectTreeNode,
  value: ProjectSelection,
): boolean {
  if (value.kind === "new-worktree") {
    return value.originPath === node.path;
  }

  return (
    value.path === node.path ||
    node.worktrees.some((worktree) => worktree.path === value.path)
  );
}

export function buildProjectSessionGroups(
  state: BuildProjectSessionGroupsInput,
): ProjectSessionGroup[] {
  const allSessions = Object.values(state.sessionsById)
    .filter((session) => !isSessionSettled(session))
    .sort(compareSessionsByCreatedAtDesc);

  const sessionsByPath = new Map<string, Session[]>();
  for (const session of allSessions) {
    const bucket = sessionsByPath.get(session.startupConfig.cwd);
    if (bucket) {
      bucket.push(session);
      continue;
    }

    sessionsByPath.set(session.startupConfig.cwd, [session]);
  }

  const worktreeCounts = new Map<string, number>();
  for (const project of state.projects) {
    if (!project.worktreeOriginPath) {
      continue;
    }
    worktreeCounts.set(
      project.worktreeOriginPath,
      (worktreeCounts.get(project.worktreeOriginPath) ?? 0) + 1,
    );
  }

  const groups: ProjectSessionGroup[] = [];
  const seenPaths = new Set<string>();

  for (const project of state.projects) {
    groups.push({
      path: project.path,
      displayName: getProjectDisplayName(project),
      collapsed: project.collapsed,
      hidden: project.hidden === true,
      fromProjectList: true,
      gitBranch: project.gitBranch,
      gitUpstreamDiffStats: project.gitUpstreamDiffStats,
      isWorktree: Boolean(project.worktreeOriginPath),
      worktreeOriginName: project.worktreeOriginPath
        ? getProjectNameFromPath(project.worktreeOriginPath)
        : undefined,
      worktreeOriginPath: project.worktreeOriginPath,
      worktreeCount: worktreeCounts.get(project.path) ?? 0,
      interactionDisabled: project.interactionDisabled === true,
      sessions: sessionsByPath.get(project.path) ?? [],
    });
    seenPaths.add(project.path);
  }

  for (const [path, sessions] of sessionsByPath.entries()) {
    if (seenPaths.has(path)) {
      continue;
    }

    groups.push({
      path,
      displayName: getProjectNameFromPath(path),
      collapsed: false,
      hidden: false,
      fromProjectList: false,
      isWorktree: false,
      worktreeCount: 0,
      interactionDisabled: false,
      sessions,
    });
  }

  return groups;
}

export interface WorktreeManagerRow {
  path: string;
  label: string;
  branch?: string;
  activeSessionCount: number;
  addedLines: number;
  deletedLines: number;
  upstreamBranch: string | null;
  aheadCommits: number;
  behindCommits: number;
  removing: boolean;
}

export function buildWorktreeManagerRows(input: {
  projects: ClaudeProject[];
  sessionsById: Record<string, Session>;
  originPath: string;
}): WorktreeManagerRow[] {
  const activeSessionCounts = new Map<string, number>();
  for (const session of Object.values(input.sessionsById)) {
    if (isSessionSettled(session)) {
      continue;
    }
    const cwd = session.startupConfig.cwd;
    activeSessionCounts.set(cwd, (activeSessionCounts.get(cwd) ?? 0) + 1);
  }

  return input.projects
    .filter((project) => project.worktreeOriginPath === input.originPath)
    .map((project) => ({
      path: project.path,
      label: getWorktreeDisplayName(project),
      branch: project.gitBranch,
      activeSessionCount: activeSessionCounts.get(project.path) ?? 0,
      addedLines: project.gitDiffStats?.addedLines ?? 0,
      deletedLines: project.gitDiffStats?.deletedLines ?? 0,
      upstreamBranch: project.gitUpstreamDiffStats?.upstreamBranch ?? null,
      aheadCommits: project.gitUpstreamDiffStats?.aheadCommits ?? 0,
      behindCommits: project.gitUpstreamDiffStats?.behindCommits ?? 0,
      removing: project.interactionDisabled === true,
    }));
}
