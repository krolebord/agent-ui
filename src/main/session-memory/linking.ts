import * as fsp from "node:fs/promises";
import path from "node:path";
import type { Session } from "../sessions/state";
import type {
  ConversationLinker,
  LinkableConversation,
} from "./store/index-writer";

export interface LinkProject {
  path: string;
  worktreeOriginPath?: string;
}

/** What `<dir>/.git` says about `dir`. */
export type GitDirInfo =
  | { kind: "none" }
  | { kind: "missing-dir" }
  | { kind: "repo" }
  | { kind: "worktree"; originPath: string };

export type GitDirInspector = (dir: string) => Promise<GitDirInfo>;

const WORKTREE_GITDIR_PATTERN =
  /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/;

export const inspectGitDir: GitDirInspector = async (dir) => {
  const gitPath = path.join(dir, ".git");
  try {
    const stats = await fsp.stat(gitPath);
    if (stats.isDirectory()) {
      return { kind: "repo" };
    }
    const content = await fsp.readFile(gitPath, "utf8");
    const gitdir = /^gitdir:\s*(.+)$/m.exec(content)?.[1]?.trim();
    const match = gitdir
      ? WORKTREE_GITDIR_PATTERN.exec(path.resolve(dir, gitdir))
      : null;
    return match?.[1]
      ? { kind: "worktree", originPath: match[1] }
      : { kind: "repo" };
  } catch {
    try {
      await fsp.access(dir);
      return { kind: "none" };
    } catch {
      return { kind: "missing-dir" };
    }
  }
};

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function sessionKey(agent: string, nativeId: string): string {
  return `${agent}\u0000${nativeId}`;
}

function indexSessions(
  sessions: Readonly<Record<string, Session>>,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const [id, session] of Object.entries(sessions)) {
    switch (session.type) {
      case "claude-local-terminal":
        index.set(sessionKey("claude", session.sessionId), id);
        break;
      case "codex-local-terminal":
        if (session.codexSessionId) {
          index.set(sessionKey("codex", session.codexSessionId), id);
        }
        for (const threadId of Object.keys(session.subagentsByThreadId ?? {})) {
          index.set(sessionKey("codex", threadId), id);
        }
        break;
      case "cursor-agent":
        if (session.cursorChatId) {
          index.set(sessionKey("cursor", session.cursorChatId), id);
        }
        break;
      case "local-terminal":
      case "worktree-setup":
        break;
      default: {
        const exhaustive: never = session;
        return exhaustive;
      }
    }
  }
  return index;
}

/**
 * Maps conversations to agent-ui projects (worktrees resolve to their origin
 * project) and to the agent-ui session that ran them. Caches per cwd, so build
 * a fresh linker for each sync.
 */
export function createConversationLinker(input: {
  projects: readonly LinkProject[];
  sessions: Readonly<Record<string, Session>>;
  inspectGitDir?: GitDirInspector;
}): ConversationLinker {
  const inspect = input.inspectGitDir ?? inspectGitDir;
  const projects = [...input.projects].sort(
    (a, b) => b.path.length - a.path.length,
  );
  const sessionIndex = indexSessions(input.sessions);
  const projectCache = new Map<string, Promise<string | null>>();

  const matchRegistered = (dir: string): string | null => {
    const project = projects.find((candidate) => isWithin(dir, candidate.path));
    if (!project) {
      return null;
    }
    return project.worktreeOriginPath ?? project.path;
  };

  const matchDeletedSibling = async (cwd: string): Promise<string | null> => {
    for (const project of projects) {
      if (project.worktreeOriginPath) {
        continue;
      }
      const parent = path.dirname(project.path);
      if (!isWithin(cwd, parent) || cwd === parent) {
        continue;
      }
      const segment = path.relative(parent, cwd).split(path.sep)[0] ?? "";
      if (!segment.startsWith(`${path.basename(project.path)}-`)) {
        continue;
      }
      const info = await inspect(path.join(parent, segment));
      if (info.kind === "missing-dir") {
        return project.path;
      }
    }
    return null;
  };

  const resolveUncached = async (cwd: string): Promise<string | null> => {
    const registered = matchRegistered(cwd);
    if (registered !== null) {
      return registered;
    }
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      const info = await inspect(dir);
      if (info.kind === "repo") {
        return null;
      }
      if (info.kind === "worktree") {
        return matchRegistered(info.originPath);
      }
      if (path.dirname(dir) === dir) {
        break;
      }
    }
    return await matchDeletedSibling(cwd);
  };

  return {
    resolveProjectPath(cwd) {
      if (cwd === null || !path.isAbsolute(cwd)) {
        return Promise.resolve(null);
      }
      const normalized = path.resolve(cwd);
      let cached = projectCache.get(normalized);
      if (!cached) {
        cached = resolveUncached(normalized);
        projectCache.set(normalized, cached);
      }
      return cached;
    },
    resolveAgentUiSessionId(conversation: LinkableConversation) {
      const direct = sessionIndex.get(
        sessionKey(conversation.agent, conversation.nativeId),
      );
      if (direct !== undefined) {
        return direct;
      }
      if (
        conversation.relation === "subagent" &&
        conversation.parentNativeId !== null
      ) {
        return (
          sessionIndex.get(
            sessionKey(conversation.agent, conversation.parentNativeId),
          ) ?? null
        );
      }
      return null;
    },
  };
}
