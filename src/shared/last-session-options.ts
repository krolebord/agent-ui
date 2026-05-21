import z from "zod";
import {
  type ClaudeEffort,
  type ClaudeModel,
  type ClaudePermissionMode,
  type CursorAgentMode,
  type CursorAgentPermissionMode,
  claudeEffortSchema,
  claudeModelSchema,
  claudePermissionModeSchema,
} from "./claude-types";
import {
  type CodexFastMode,
  type CodexModelReasoningEffort,
  type CodexPermissionMode,
  codexFastModeSchema,
  codexModelReasoningEffortSchema,
  codexPermissionModeSchema,
} from "./codex-types";

export const lastSessionTypeSchema = z.enum(["claude", "codex", "cursorAgent"]);

export type LastSessionType = z.infer<typeof lastSessionTypeSchema>;

export interface LastClaudeSessionOptions {
  model: ClaudeModel;
  effort?: ClaudeEffort;
  permissionMode: ClaudePermissionMode;
  haikuModelOverride?: ClaudeModel;
  subagentModelOverride?: ClaudeModel;
  systemPrompt?: string;
}

export interface LastCodexSessionOptions {
  model?: string;
  modelReasoningEffort: CodexModelReasoningEffort;
  fastMode: CodexFastMode;
  permissionMode: CodexPermissionMode;
  configOverrides?: string;
}

export interface LastCursorSessionOptions {
  model?: string;
  mode?: CursorAgentMode;
  permissionMode: CursorAgentPermissionMode;
}

export interface LastSessionOptions {
  lastSessionType?: LastSessionType;
  claude?: LastClaudeSessionOptions;
  codex?: LastCodexSessionOptions;
  cursor?: LastCursorSessionOptions;
}

const cursorAgentModeSchema = z.enum(["plan", "ask"]);
const cursorAgentPermissionModeSchema = z.enum(["default", "yolo"]);

export const lastClaudeSessionOptionsSchema = z.object({
  model: claudeModelSchema.catch("opus"),
  effort: claudeEffortSchema.optional().catch(undefined),
  permissionMode: claudePermissionModeSchema.catch("default"),
  haikuModelOverride: claudeModelSchema.optional().catch(undefined),
  subagentModelOverride: claudeModelSchema.optional().catch(undefined),
  systemPrompt: z.string().optional().catch(undefined),
});

export const lastCodexSessionOptionsSchema = z.object({
  model: z.string().optional().catch(undefined),
  modelReasoningEffort: codexModelReasoningEffortSchema.catch("high"),
  fastMode: codexFastModeSchema.catch("default"),
  permissionMode: codexPermissionModeSchema.catch("default"),
  configOverrides: z.string().optional().catch(undefined),
});

export const lastCursorSessionOptionsSchema = z.object({
  model: z.string().optional().catch(undefined),
  mode: cursorAgentModeSchema.optional().catch(undefined),
  permissionMode: cursorAgentPermissionModeSchema.catch("default"),
});

export const lastSessionOptionsSchema = z.object({
  lastSessionType: lastSessionTypeSchema.optional().catch(undefined),
  claude: lastClaudeSessionOptionsSchema.optional().catch(undefined),
  codex: lastCodexSessionOptionsSchema.optional().catch(undefined),
  cursor: lastCursorSessionOptionsSchema.optional().catch(undefined),
});

export function defaultClaudeSessionOptions(): LastClaudeSessionOptions {
  return {
    model: "opus",
    effort: undefined,
    permissionMode: "default",
    haikuModelOverride: undefined,
    subagentModelOverride: undefined,
    systemPrompt: undefined,
  };
}

export function defaultCodexSessionOptions(): LastCodexSessionOptions {
  return {
    model: undefined,
    modelReasoningEffort: "high",
    fastMode: "default",
    permissionMode: "default",
    configOverrides: undefined,
  };
}

export function defaultCursorSessionOptions(): LastCursorSessionOptions {
  return {
    model: undefined,
    mode: undefined,
    permissionMode: "default",
  };
}

export function resolveClaudeSessionOptions(
  stored: LastClaudeSessionOptions | undefined,
): LastClaudeSessionOptions {
  return {
    ...defaultClaudeSessionOptions(),
    ...stored,
  };
}

export function resolveCodexSessionOptions(
  stored: LastCodexSessionOptions | undefined,
): LastCodexSessionOptions {
  return {
    ...defaultCodexSessionOptions(),
    ...stored,
  };
}

export function resolveCursorSessionOptions(
  stored: LastCursorSessionOptions | undefined,
): LastCursorSessionOptions {
  return {
    ...defaultCursorSessionOptions(),
    ...stored,
  };
}
