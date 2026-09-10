import { z } from "zod";

export const projectCommandSchema = z.object({
  id: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(120),
  run: z.string().trim().min(1),
  cwd: z.string().trim().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  singleton: z.boolean().optional(),
});

export type ProjectCommand = z.infer<typeof projectCommandSchema>;

export const PROJECT_COMMANDS_LIMIT = 50;

export interface RunnableProjectCommand extends ProjectCommand {
  id: string;
}

export interface ResolvedProjectCommand extends RunnableProjectCommand {
  explicitId?: string;
  sourceIndex: number;
}

export const SCRIPT_COMMAND_ID_PREFIX = "script:";

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
