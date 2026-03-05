import { shellQuote } from "@shared/utils";
import type {
  ClaudeEffort,
  ClaudeModel,
  ClaudePermissionMode,
} from "../shared/claude-types";

export type ClaudeStartOptions =
  | {
      type: "start-new";
      sessionId: string;
      forkSessionId?: string;
    }
  | {
      type: "resume";
      sessionId: string;
    };

export interface BuildClaudeArgsInput {
  permissionMode: ClaudePermissionMode;
  pluginDir: string | null;
  model: ClaudeModel;
  effort?: ClaudeEffort;
  haikuModelOverride?: ClaudeModel;
  subagentModelOverride?: ClaudeModel;
  systemPrompt?: string;
  stateFilePath: string;
  initialPrompt?: string;
  start: ClaudeStartOptions;
}

function getPermissionArgs(permissionMode: ClaudePermissionMode): string[] {
  if (permissionMode === "yolo") {
    return ["--dangerously-skip-permissions"];
  }

  return ["--permission-mode", permissionMode];
}

function buildStartArgs(input: ClaudeStartOptions): string[] {
  switch (input.type) {
    case "resume":
      return ["--resume", shellQuote(input.sessionId)];
    case "start-new": {
      const args = ["--session-id", shellQuote(input.sessionId)];
      if (input.forkSessionId) {
        args.push(
          "--fork-session",
          "--resume",
          shellQuote(input.forkSessionId),
        );
      }
      return args;
    }
  }
}

export function buildClaudeArgs(input: BuildClaudeArgsInput): {
  args: string[];
  env: Record<string, string>;
} {
  const args: string[] = [];
  args.push(...getPermissionArgs(input.permissionMode));

  if (input.pluginDir) {
    args.push("--plugin-dir", shellQuote(input.pluginDir));
  }

  if (input.model) {
    args.push("--model", input.model);
  }

  if (input.effort) {
    args.push("--effort", input.effort);
  }

  if (input.systemPrompt?.trim()) {
    args.push("--system-prompt", shellQuote(input.systemPrompt));
  }

  args.push(...buildStartArgs(input.start));

  if (input.initialPrompt?.trim()) {
    args.push(shellQuote(input.initialPrompt));
  }

  const env: Record<string, string> = {
    AGENT_UI_STATE_FILE: input.stateFilePath,
    CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "true",
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
    DISABLE_BUG_COMMAND: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_TELEMETRY: "1",
  };

  if (input.haikuModelOverride) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = input.haikuModelOverride;
  }

  if (input.subagentModelOverride) {
    env.CLAUDE_CODE_SUBAGENT_MODEL = input.subagentModelOverride;
  }

  return { args: args.filter(Boolean), env };
}
