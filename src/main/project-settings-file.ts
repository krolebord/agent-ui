import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type ParseError, applyEdits, modify, parse } from "jsonc-parser";
import z from "zod";
import {
  claudeEffortSchema,
  claudeModelSchema,
  claudePermissionModeSchema,
} from "../shared/claude-types";
import log from "./logger";

const SETTINGS_DIR = ".claude-ui";
const SETTINGS_FILE = "settings.jsonc";

export const projectSettingsFileSchema = z.object({
  defaultModel: claudeModelSchema.optional().catch(undefined),
  defaultPermissionMode: claudePermissionModeSchema.optional().catch(undefined),
  defaultEffort: claudeEffortSchema.optional().catch(undefined),
  defaultHaikuModelOverride: claudeModelSchema.optional().catch(undefined),
  defaultSubagentModelOverride: claudeModelSchema.optional().catch(undefined),
  defaultSystemPrompt: z.string().optional().catch(undefined),
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

const SETTINGS_KEYS = [
  "defaultModel",
  "defaultPermissionMode",
  "defaultEffort",
  "defaultHaikuModelOverride",
  "defaultSubagentModelOverride",
  "defaultSystemPrompt",
] as const satisfies readonly (keyof ProjectSettingsFile)[];

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

  for (const key of SETTINGS_KEYS) {
    const value = settings[key];
    const edits = modify(content, [key], value ?? undefined, {
      isArrayInsertion: false,
      formattingOptions: { tabSize: 2, insertSpaces: true },
    });
    content = applyEdits(content, edits);
  }

  await mkdir(dir, { recursive: true });
  await writeFile(filePath, content, "utf-8");
}
