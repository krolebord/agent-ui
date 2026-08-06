import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  PROJECT_SCRIPTS_LIMIT,
  type RunnableProjectCommand,
  scriptCommandId,
} from "../shared/project-commands";
import log from "./logger";
import { readProjectSettingsFile } from "./project-settings-file";

/**
 * `package.json` scripts, offered alongside the presets a project checks into
 * `.agent-ui/settings.jsonc`. Same trust as a preset — repository shell code the
 * user launches by hand — but inferred rather than declared, so nothing here is
 * editable from the app.
 */

const PACKAGE_FILE = "package.json";
const PNPM_LOCKFILE = "pnpm-lock.yaml";

/**
 * Script names are typed into a shell verbatim, so only unambiguous ones are
 * offered. Anything else is a package the app can't run safely without quoting
 * rules nobody has asked for yet.
 */
const SAFE_SCRIPT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9:_.-]*$/;

interface PackageManifest {
  scripts?: Record<string, unknown>;
  packageManager?: unknown;
}

async function readManifest(
  projectPath: string,
): Promise<PackageManifest | null> {
  const filePath = path.join(projectPath, PACKAGE_FILE);
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    log.warn(`Failed to read ${filePath}:`, error);
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as PackageManifest;
  } catch (error) {
    log.warn(`Failed to parse ${filePath}:`, error);
    return null;
  }
}

/**
 * Only pnpm is supported, so a project on another package manager gets an empty
 * list rather than a `pnpm run` that fails in its own confusing way. The
 * `packageManager` field is checked alongside the lockfile because plenty of
 * repositories gitignore the lockfile but still pin the manager.
 */
async function usesPnpm(
  projectPath: string,
  manifest: PackageManifest,
): Promise<boolean> {
  const declared = manifest.packageManager;
  if (
    typeof declared === "string" &&
    (declared === "pnpm" || declared.startsWith("pnpm@"))
  ) {
    return true;
  }

  try {
    await access(path.join(projectPath, PNPM_LOCKFILE));
    return true;
  } catch {
    return false;
  }
}

/**
 * Declaration order is authored — `dev` and `build` sit at the top, one-off
 * tooling at the bottom — so the list is truncated rather than sorted.
 */
function collectScripts(manifest: PackageManifest): RunnableProjectCommand[] {
  const scripts = manifest.scripts;
  if (typeof scripts !== "object" || scripts === null) {
    return [];
  }

  const names = Object.keys(scripts).filter(
    (name) =>
      SAFE_SCRIPT_NAME.test(name) &&
      typeof scripts[name] === "string" &&
      (scripts[name] as string).trim().length > 0,
  );
  const declared = new Set(names);

  const commands: RunnableProjectCommand[] = [];
  for (const name of names) {
    if (commands.length >= PROJECT_SCRIPTS_LIMIT) {
      break;
    }
    // npm runs these around their target script, so listing them as separately
    // runnable entries only invites confusion.
    const hooked = /^(pre|post)(.+)$/.exec(name);
    if (hooked && declared.has(hooked[2])) {
      continue;
    }
    commands.push({
      id: scriptCommandId(name),
      name,
      run: `pnpm run ${name}`,
    });
  }

  return commands;
}

/**
 * Discovered scripts for a checkout, or an empty list when the project opted
 * out, isn't on pnpm, or has no manifest. Read fresh on every call, like the
 * file presets: both are edited outside the app.
 */
export async function readProjectScripts(
  projectPath: string,
): Promise<RunnableProjectCommand[]> {
  const settings = await readProjectSettingsFile(projectPath);
  if (settings?.discoverCommands === false) {
    return [];
  }

  const manifest = await readManifest(projectPath);
  if (!manifest) {
    return [];
  }
  if (!(await usesPnpm(projectPath, manifest))) {
    return [];
  }

  return collectScripts(manifest);
}
