import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  PROJECT_SCRIPTS_LIMIT,
  type RunnableProjectCommand,
  scriptCommandId,
} from "../shared/project-commands";
import log from "./logger";
import { readProjectSettingsFile } from "./project-settings-file";

const PACKAGE_FILE = "package.json";
const PNPM_LOCKFILE = "pnpm-lock.yaml";

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
