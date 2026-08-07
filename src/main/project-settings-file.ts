import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser";
import z from "zod";
import {
  normalizeProjectCommands,
  PROJECT_COMMANDS_LIMIT,
  type ProjectCommandWrite,
  type ResolvedProjectCommand,
} from "../shared/project-commands";
import log from "./logger";

const SETTINGS_DIR = ".agent-ui";
const SETTINGS_FILE = "settings.jsonc";

/** Project-relative directory holding all checked-in Agent UI configuration. */
export const PROJECT_SETTINGS_DIR = SETTINGS_DIR;

export const PROJECT_SETTINGS_RELATIVE_PATH = `${SETTINGS_DIR}/${SETTINGS_FILE}`;

const FORMATTING_OPTIONS = { tabSize: 2, insertSpaces: true } as const;

export const projectSettingsFileSchema = z.object({
  worktreeSetupCommands: z.string().optional().catch(undefined),
  /**
   * Left as `unknown` in the schema so a single malformed preset is dropped by
   * the normalizer instead of invalidating every other key in the file.
   */
  commands: z.unknown().transform(normalizeProjectCommands).optional(),
  /**
   * Project-relative path to the icon shown for this project, checked before
   * the conventional favicon locations. Read-only for us: nothing in the app
   * writes it, so a repository can check it in and keep it.
   */
  iconPath: z.string().trim().min(1).optional().catch(undefined),
  /**
   * Set to `false` to keep `package.json` scripts out of the commands menu.
   * On by default, and read-only for us like `iconPath`.
   */
  discoverCommands: z.boolean().optional().catch(undefined),
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
    const raw = parse(content, errors, { allowTrailingComma: true });
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

/**
 * Presets are edited outside the app — by hand or by an agent — so every
 * consumer reads them fresh instead of trusting a cached copy.
 */
export async function readProjectCommands(
  projectPath: string,
): Promise<ResolvedProjectCommand[]> {
  const settings = await readProjectSettingsFile(projectPath);
  return settings?.commands ?? [];
}

const COMMAND_KEYS = ["id", "name", "run", "cwd", "env", "singleton"] as const;

function serializeCommand(command: ProjectCommandWrite) {
  const serialized: Record<string, unknown> = {};
  for (const key of COMMAND_KEYS) {
    const value = command[key];
    if (value !== undefined) {
      serialized[key] = value;
    }
  }
  return serialized;
}

/** Key order is irrelevant for equality here; only the values decide a rewrite. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([key, entryValue]) =>
        `${JSON.stringify(key)}:${stableStringify(entryValue)}`,
    );
  return `{${entries.join(",")}}`;
}

function editSettings(
  content: string,
  jsonPath: (string | number)[],
  value: unknown,
  isArrayInsertion = false,
): string {
  const edits = modify(content, jsonPath, value, {
    isArrayInsertion,
    formattingOptions: { ...FORMATTING_OPTIONS },
  });
  return applyEdits(content, edits);
}

/**
 * Rewrites the `commands` array with per-entry edits rather than replacing the
 * whole value, so comments and formatting on untouched presets survive. Entries
 * carry the index they were read from; new ones are appended. Reordering is not
 * expressible this way and is rejected — the dialog doesn't offer it.
 */
export async function writeProjectCommands(
  projectPath: string,
  commands: ProjectCommandWrite[],
): Promise<void> {
  if (commands.length > PROJECT_COMMANDS_LIMIT) {
    throw new Error(
      `A project can define at most ${PROJECT_COMMANDS_LIMIT} commands.`,
    );
  }

  const filePath = settingsFilePath(projectPath);
  const dir = path.dirname(filePath);

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    content = "{}";
  }

  const errors: ParseError[] = [];
  const parsed = parse(content, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(
      `${PROJECT_SETTINGS_RELATIVE_PATH} could not be parsed, so it was left untouched. Fix the file and try again.`,
    );
  }

  const rawCommands: unknown[] =
    parsed && typeof parsed === "object" && Array.isArray(parsed.commands)
      ? parsed.commands
      : [];
  const existing = normalizeProjectCommands(rawCommands);
  const existingByIndex = new Map(
    existing.map((command) => [command.sourceIndex, command]),
  );

  const kept = commands.filter((command) => command.sourceIndex !== undefined);
  for (const command of kept) {
    if (!existingByIndex.has(command.sourceIndex as number)) {
      throw new Error(
        `${PROJECT_SETTINGS_RELATIVE_PATH} changed on disk. Reopen the dialog and try again.`,
      );
    }
  }

  const keptIndexes = kept.map((command) => command.sourceIndex as number);
  const isAscending = keptIndexes.every(
    (index, position) => position === 0 || index > keptIndexes[position - 1],
  );
  if (!isAscending) {
    throw new Error(
      "Reordering commands is not supported. Edit the file directly to change their order.",
    );
  }

  // No existing entries to preserve means no comments to lose: write the array
  // in one go, which also creates the key when the file doesn't have it yet.
  if (existing.length === 0) {
    const value =
      commands.length > 0 ? commands.map(serializeCommand) : undefined;
    content = editSettings(content, ["commands"], value);
  } else if (commands.length === 0 && rawCommands.length === existing.length) {
    // Everything is gone and nothing unparseable is hiding in the array.
    content = editSettings(content, ["commands"], undefined);
  } else {
    // Field edits first: they leave indexes alone, which deletions do not.
    for (const command of kept) {
      const sourceIndex = command.sourceIndex as number;
      const raw = rawCommands[sourceIndex] as Record<string, unknown>;
      const next = serializeCommand(command);
      for (const key of COMMAND_KEYS) {
        if (stableStringify(raw?.[key]) === stableStringify(next[key])) {
          continue;
        }
        content = editSettings(
          content,
          ["commands", sourceIndex, key],
          next[key],
        );
      }
    }

    const keptSet = new Set(keptIndexes);
    const removed = existing
      .map((command) => command.sourceIndex)
      .filter((index) => !keptSet.has(index))
      .sort((a, b) => b - a);
    for (const index of removed) {
      content = editSettings(content, ["commands", index], undefined);
    }

    for (const command of commands) {
      if (command.sourceIndex !== undefined) {
        continue;
      }
      content = editSettings(
        content,
        ["commands", -1],
        serializeCommand(command),
        true,
      );
    }
  }

  await mkdir(dir, { recursive: true });
  await writeFile(filePath, content, "utf-8");
}
