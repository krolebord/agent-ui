import { homedir } from "node:os";
import path from "node:path";
import { commitMessageSystemPrompt } from "../../commit-message-generation/prompts";
import { getTextGenerationWorkingDirectory } from "../../text-generation-workspace";
import { systemPrompt as titleSystemPrompt } from "../../title-generation-prompts";
import { normalizeWhitespace } from "./text";
import type {
  ConversationOrigin,
  ParsedTurn,
  TextGenerationRules,
} from "./types";

const TEXT_GENERATION_ROLE_LINES = [
  titleSystemPrompt,
  commitMessageSystemPrompt,
]
  .map((prompt) => normalizeWhitespace(prompt.trim().split("\n")[0] ?? ""))
  .filter((roleLine) => roleLine.length > 0);

/** Mirrors `scripts/headless-install-paths.sh`. */
export function resolveHeadlessInstallRoot(
  options: { env?: Record<string, string | undefined>; homeDir?: string } = {},
): string {
  const env = options.env ?? process.env;
  if (env.AGENT_UI_INSTALL_DIR) {
    return env.AGENT_UI_INSTALL_DIR;
  }
  if (env.XDG_DATA_HOME) {
    return path.join(env.XDG_DATA_HOME, "agent-ui");
  }
  return path.join(options.homeDir ?? homedir(), ".local", "share", "agent-ui");
}

export function createTextGenerationRules(input: {
  userDataPath: string;
  installRoots: readonly string[];
}): TextGenerationRules {
  return {
    workspaceDirs: [getTextGenerationWorkingDirectory(input.userDataPath)],
    excludedCwdPrefixes: input.installRoots.map((root) =>
      path.join(root, "releases"),
    ),
  };
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function isTextGenerationCwd(
  cwd: string,
  rules: TextGenerationRules,
): boolean {
  const resolved = path.resolve(cwd);
  return (
    rules.workspaceDirs.some((dir) => path.resolve(dir) === resolved) ||
    rules.excludedCwdPrefixes.some((prefix) =>
      isWithin(resolved, path.resolve(prefix)),
    )
  );
}

export function startsWithTextGenerationPrompt(userText: string): boolean {
  const normalized = normalizeWhitespace(userText.slice(0, 4000));
  return TEXT_GENERATION_ROLE_LINES.some((roleLine) =>
    normalized.startsWith(roleLine),
  );
}

export function isTextGenerationConversation(
  input: { cwd: string | null; firstUserText: string | null },
  rules: TextGenerationRules,
): boolean {
  return (
    (input.cwd !== null && isTextGenerationCwd(input.cwd, rules)) ||
    (input.firstUserText !== null &&
      startsWithTextGenerationPrompt(input.firstUserText))
  );
}

export function classifyOrigin(
  cwd: string | null,
  turns: readonly ParsedTurn[],
  rules: TextGenerationRules,
): ConversationOrigin {
  const firstUserText =
    turns.find((turn) => turn.userText.length > 0)?.userText ?? null;
  return isTextGenerationConversation({ cwd, firstUserText }, rules)
    ? "text-generation"
    : "user";
}
