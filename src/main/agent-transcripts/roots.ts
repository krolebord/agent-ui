import { homedir } from "node:os";
import path from "node:path";

export interface TranscriptRoots {
  claudeProjects: string;
  codexSessions: string;
  cursorProjects: string;
  cursorChats: string;
}

export interface TranscriptRootsOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string;
}

export function resolveTranscriptRoots(
  options: TranscriptRootsOptions = {},
): TranscriptRoots {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const claudeHome =
    env.CLAUDE_CONFIG_DIR?.trim() || path.join(homeDir, ".claude");
  const codexHome = env.CODEX_HOME?.trim() || path.join(homeDir, ".codex");
  const cursorHome = path.join(homeDir, ".cursor");
  return {
    claudeProjects: path.join(claudeHome, "projects"),
    codexSessions: path.join(codexHome, "sessions"),
    cursorProjects: path.join(cursorHome, "projects"),
    cursorChats: path.join(cursorHome, "chats"),
  };
}
