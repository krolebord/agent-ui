import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser";
import z from "zod";
import log from "./logger";

const SETTINGS_DIR = ".agent-ui";
const SETTINGS_FILE = "settings.jsonc";

export const projectSettingsFileSchema = z.object({
  worktreeSetupCommands: z.string().optional().catch(undefined),
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
  "localClaude",
  "localCodex",
  "localCursor",
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

  const worktreeSetupCommands = settings.worktreeSetupCommands ?? undefined;

  const edits = modify(
    content,
    ["worktreeSetupCommands"],
    worktreeSetupCommands,
    {
      isArrayInsertion: false,
      formattingOptions: { tabSize: 2, insertSpaces: true },
    },
  );
  content = applyEdits(content, edits);

  for (const key of LEGACY_SETTINGS_KEYS) {
    const legacyEdits = modify(content, [key], undefined, {
      isArrayInsertion: false,
      formattingOptions: { tabSize: 2, insertSpaces: true },
    });
    content = applyEdits(content, legacyEdits);
  }

  await mkdir(dir, { recursive: true });
  await writeFile(filePath, content, "utf-8");
}
