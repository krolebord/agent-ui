import { z } from "zod";

/**
 * Command presets a project checks into `.agent-ui/settings.jsonc`, launched
 * on demand as project terminals. Nothing runs them automatically: a preset is
 * shell code from a repository, so it only executes when the user picks it.
 */
export const projectCommandSchema = z.object({
  /**
   * Optional stable key. Left out, it is derived from the name — which means a
   * rename changes the id, so presets referenced elsewhere should set it.
   */
  id: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(120),
  run: z.string().trim().min(1),
  /** Project-relative working directory. Defaults to the project root. */
  cwd: z.string().trim().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** Focus the existing terminal for this preset instead of opening a second. */
  singleton: z.boolean().optional(),
});

export type ProjectCommand = z.infer<typeof projectCommandSchema>;

/** Keeps a malformed file from producing an unbounded list. */
export const PROJECT_COMMANDS_LIMIT = 50;

/**
 * Everything a terminal needs to launch a command, whatever declared it. File
 * presets and discovered `package.json` scripts both satisfy this.
 */
export interface RunnableProjectCommand extends ProjectCommand {
  /** Always set: the explicit id when present, otherwise derived from the name. */
  id: string;
}

export interface ResolvedProjectCommand extends RunnableProjectCommand {
  /** Set only when the file spells out an id, so writes don't materialize derived ones. */
  explicitId?: string;
  /** Position in the on-disk array, which is what targeted JSONC edits address. */
  sourceIndex: number;
}

/**
 * Discovered scripts share the command id namespace with file presets, so they
 * carry a prefix no derived preset id can produce — `slugifyCommandName` strips
 * the colon. A preset that spells out a colliding id wins: resolution consults
 * the file first.
 */
export const SCRIPT_COMMAND_ID_PREFIX = "script:";

/** Caps the discovered list so a repository with 80 scripts can't drown the menu. */
export const PROJECT_SCRIPTS_LIMIT = 25;

export function scriptCommandId(scriptName: string): string {
  return `${SCRIPT_COMMAND_ID_PREFIX}${scriptName}`;
}

export function parseScriptCommandId(commandId: string): string | null {
  if (!commandId.startsWith(SCRIPT_COMMAND_ID_PREFIX)) {
    return null;
  }
  return commandId.slice(SCRIPT_COMMAND_ID_PREFIX.length) || null;
}

export const projectCommandWriteSchema = projectCommandSchema.extend({
  /** Omitted for entries the dialog just added. */
  sourceIndex: z.number().int().min(0).optional(),
});

export type ProjectCommandWrite = z.infer<typeof projectCommandWriteSchema>;

export function slugifyCommandName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "command";
}

/**
 * Parses the raw `commands` value from a project file. Entries that fail
 * validation are skipped rather than invalidating the whole list, so one bad
 * hand-written preset doesn't hide the rest.
 */
export function normalizeProjectCommands(
  raw: unknown,
): ResolvedProjectCommand[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const commands: ResolvedProjectCommand[] = [];
  const usedIds = new Set<string>();

  raw.forEach((entry, sourceIndex) => {
    if (commands.length >= PROJECT_COMMANDS_LIMIT) {
      return;
    }
    const parsed = projectCommandSchema.safeParse(entry);
    if (!parsed.success) {
      return;
    }

    const base = parsed.data.id ?? slugifyCommandName(parsed.data.name);
    let id = base;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);

    commands.push({
      ...parsed.data,
      id,
      explicitId: parsed.data.id,
      sourceIndex,
    });
  });

  return commands;
}

/**
 * Renders `env` for the dialog as `KEY=value` lines, which reads better than a
 * grid of inputs for the handful of variables a preset usually needs.
 */
export function formatCommandEnv(env: Record<string, string> | undefined) {
  return Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export function parseCommandEnv(
  value: string,
): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    if (!key) {
      continue;
    }
    env[key] = trimmed.slice(separator + 1).trim();
  }
  return Object.keys(env).length > 0 ? env : undefined;
}
