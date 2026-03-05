import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser";
import z from "zod";
import {
  claudeEffortSchema,
  claudeModelSchema,
  claudePermissionModeSchema,
} from "../shared/claude-types";
import {
  codexModelReasoningEffortSchema,
  codexPermissionModeSchema,
} from "../shared/codex-types";
import log from "./logger";

const cursorAgentModeSchema = z.enum(["plan", "ask"]);
const cursorAgentPermissionModeSchema = z.enum(["default", "yolo"]);

const SETTINGS_DIR = ".agent-ui";
const SETTINGS_FILE = "settings.jsonc";

const localClaudeProjectSettingsSchema = z.object({
  defaultModel: claudeModelSchema.optional().catch(undefined),
  defaultPermissionMode: claudePermissionModeSchema.optional().catch(undefined),
  defaultEffort: claudeEffortSchema.optional().catch(undefined),
  defaultHaikuModelOverride: claudeModelSchema.optional().catch(undefined),
  defaultSubagentModelOverride: claudeModelSchema.optional().catch(undefined),
  defaultSystemPrompt: z.string().optional().catch(undefined),
});

const localCodexProjectSettingsSchema = z.object({
  model: z.string().optional().catch(undefined),
  permissionMode: codexPermissionModeSchema.optional().catch(undefined),
  modelReasoningEffort: codexModelReasoningEffortSchema
    .optional()
    .catch(undefined),
  configOverrides: z.string().optional().catch(undefined),
});

const localCursorProjectSettingsSchema = z.object({
  model: z.string().optional().catch(undefined),
  mode: cursorAgentModeSchema.optional().catch(undefined),
  permissionMode: cursorAgentPermissionModeSchema.optional().catch(undefined),
});

function toOptionalSettings<T extends Record<string, unknown>>(
  value: T | undefined,
): T | undefined {
  if (!value) {
    return undefined;
  }
  return Object.values(value).some((item) => item !== undefined)
    ? value
    : undefined;
}

export const projectSettingsFileSchema = z.object({
  localClaude: localClaudeProjectSettingsSchema.optional().catch(undefined),
  localCodex: localCodexProjectSettingsSchema.optional().catch(undefined),
  localCursor: localCursorProjectSettingsSchema.optional().catch(undefined),
});

export type ProjectSettingsFile = z.infer<typeof projectSettingsFileSchema>;

function settingsFilePath(projectPath: string): string {
  return path.join(projectPath, SETTINGS_DIR, SETTINGS_FILE);
}

export async function readProjectSettingsFile(
  projectPath: string,
): Promise<ProjectSettingsFile | null> {
  const filePath = settingsFilePath(projectPath);
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    log.warn(`Failed to read project settings at ${filePath}:`, error);
    return null;
  }

  try {
    const errors: ParseError[] = [];
    const raw = parse(content, errors);
    if (errors.length > 0) {
      log.warn(`JSONC parse errors in ${filePath}:`, errors);
      return null;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      log.warn(`Project settings at ${filePath} is not a JSON object`);
      return null;
    }
    return projectSettingsFileSchema.parse(raw);
  } catch (error) {
    log.warn(`Failed to parse project settings at ${filePath}:`, error);
    return null;
  }
}

export async function readProjectSettingsForAll(
  paths: string[],
): Promise<Map<string, ProjectSettingsFile>> {
  const results = await Promise.allSettled(
    paths.map(async (p) => {
      const settings = await readProjectSettingsFile(p);
      return [p, settings] as const;
    }),
  );

  const map = new Map<string, ProjectSettingsFile>();
  for (const result of results) {
    if (result.status === "fulfilled") {
      const [projectPath, settings] = result.value;
      if (settings) {
        map.set(projectPath, settings);
      }
    }
  }
  return map;
}

const LEGACY_SETTINGS_KEYS = [
  "defaultModel",
  "defaultPermissionMode",
  "defaultEffort",
  "defaultHaikuModelOverride",
  "defaultSubagentModelOverride",
  "defaultSystemPrompt",
] as const;

export async function writeProjectSettingsFile(
  projectPath: string,
  settings: ProjectSettingsFile,
): Promise<void> {
  const filePath = settingsFilePath(projectPath);
  const dir = path.dirname(filePath);

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    content = "{}";
  }

  const localClaude = toOptionalSettings(settings.localClaude);
  const localCodex = toOptionalSettings(settings.localCodex);
  const localCursor = toOptionalSettings(settings.localCursor);

  for (const [key, value] of [
    ["localClaude", localClaude],
    ["localCodex", localCodex],
    ["localCursor", localCursor],
  ] as const) {
    const edits = modify(content, [key], value ?? undefined, {
      isArrayInsertion: false,
      formattingOptions: { tabSize: 2, insertSpaces: true },
    });
    content = applyEdits(content, edits);
  }

  for (const key of LEGACY_SETTINGS_KEYS) {
    const edits = modify(content, [key], undefined, {
      isArrayInsertion: false,
      formattingOptions: { tabSize: 2, insertSpaces: true },
    });
    content = applyEdits(content, edits);
  }

  await mkdir(dir, { recursive: true });
  await writeFile(filePath, content, "utf-8");
}
