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
  remoteControl?: boolean;
  mcpEnabled?: boolean;
  accountId?: string;
}

export interface LastCodexSessionOptions {
  model?: string;
  recentModels: string[];
  modelReasoningEffort: CodexModelReasoningEffort;
  fastMode: CodexFastMode;
  permissionMode: CodexPermissionMode;
  configOverrides?: string;
  mcpEnabled?: boolean;
}

export interface LastCursorSessionOptions {
  model?: string;
  recentModels: string[];
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
  remoteControl: z.boolean().optional().catch(undefined),
  mcpEnabled: z.boolean().optional().catch(undefined),
  accountId: z.string().optional().catch(undefined),
});

export const lastCodexSessionOptionsSchema = z.object({
  model: z.string().optional().catch(undefined),
  recentModels: z
    .array(z.string().trim().min(1))
    .default([])
    .catch([])
    .transform((models) => [...new Set(models)].slice(0, 8)),
  modelReasoningEffort: codexModelReasoningEffortSchema.catch("high"),
  fastMode: codexFastModeSchema.catch("default"),
  permissionMode: codexPermissionModeSchema.catch("default"),
  configOverrides: z.string().optional().catch(undefined),
  mcpEnabled: z.boolean().optional().catch(undefined),
});

export const lastCursorSessionOptionsSchema = z.object({
  model: z.string().optional().catch(undefined),
  recentModels: z
    .array(z.string().trim().min(1))
    .default([])
    .catch([])
    .transform((models) => [...new Set(models)].slice(0, 8)),
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
    remoteControl: undefined,
    mcpEnabled: undefined,
    accountId: undefined,
  };
}

export function defaultCodexSessionOptions(): LastCodexSessionOptions {
  return {
    model: undefined,
    recentModels: [],
    modelReasoningEffort: "high",
    fastMode: "default",
    permissionMode: "default",
    configOverrides: undefined,
    mcpEnabled: undefined,
  };
}

export function defaultCursorSessionOptions(): LastCursorSessionOptions {
  return {
    model: undefined,
    recentModels: [],
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
