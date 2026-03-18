import type { ClaudeModel, ClaudeProject } from "@shared/claude-types";
import type { Session } from "src/main/sessions/state";

export interface ProjectSessionGroup {
  path: string;
  displayName: string;
  collapsed: boolean;
  fromProjectList: boolean;
  gitBranch?: string;
  isWorktree: boolean;
  worktreeOriginName?: string;
  sessions: Session[];
}

export const MODEL_OPTIONS: { value: ClaudeModel; label: string }[] = [
  { value: "haiku", label: "Haiku" },
  { value: "sonnet", label: "Sonnet" },
  { value: "sonnet[1m]", label: "Sonnet 1m" },
  { value: "opus", label: "Opus" },
];

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

export function buildProjectSessionGroups(
  state: BuildProjectSessionGroupsInput,
): ProjectSessionGroup[] {
  const allSessions = Object.values(state.sessionsById).sort(
    compareSessionsByCreatedAtDesc,
  );

  const sessionsByPath = new Map<string, Session[]>();
  for (const session of allSessions) {
    const bucket = sessionsByPath.get(session.startupConfig.cwd);
    if (bucket) {
      bucket.push(session);
      continue;
    }

    sessionsByPath.set(session.startupConfig.cwd, [session]);
  }

  const groups: ProjectSessionGroup[] = [];
  const seenPaths = new Set<string>();

  for (const project of state.projects) {
    groups.push({
      path: project.path,
      displayName: getProjectDisplayName(project),
      collapsed: project.collapsed,
      fromProjectList: true,
      gitBranch: project.gitBranch,
      isWorktree: Boolean(project.worktreeOriginPath),
      worktreeOriginName: project.worktreeOriginPath
        ? getProjectNameFromPath(project.worktreeOriginPath)
        : undefined,
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
      fromProjectList: false,
      isWorktree: false,
      sessions,
    });
  }

  return groups;
}
