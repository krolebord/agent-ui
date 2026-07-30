import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import log from "./logger";
import { readProjectSettingsFile } from "./project-settings-file";

/**
 * Conventional icon locations, checked in order. Vector beats ICO beats raster
 * at each level so we pick the crispest asset a project ships, and
 * `.agent-ui/icon.*` comes first so repos with no web assets at all (CLIs,
 * libraries) still have somewhere to drop one.
 */
const FAVICON_CANDIDATES = [
  ".agent-ui/icon.svg",
  ".agent-ui/icon.png",
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "public/icon.svg",
  "public/icon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "src/app/favicon.ico",
  "src/favicon.svg",
  "src/favicon.ico",
  "src/favicon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
  "resources/icon.png",
  ".idea/icon.svg",
] as const;

/**
 * Doubles as the allowlist: a candidate whose extension is absent is never
 * read, which keeps a hand-written `iconPath` from pointing us at arbitrary
 * files.
 */
const MIME_TYPES_BY_EXTENSION = new Map<string, string>([
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".avif", "image/avif"],
]);

/**
 * Icons travel to the renderer as base64 data URLs, so the cap is about what
 * is reasonable to inline rather than what is readable. Real favicons are a
 * few KB; multi-resolution ICOs are the only ones that get close.
 */
const MAX_FAVICON_BYTES = 512 * 1024;

/** How long "this project has no icon" is trusted before scanning again. */
const MISSING_RESCAN_MS = 60_000;

type FaviconCacheEntry = {
  /** `null` once a scan found nothing usable. */
  readonly resolvedPath: string | null;
  readonly mtimeMs: number;
  readonly size: number;
  readonly dataUrl: string | null;
  readonly resolvedAt: number;
};

const faviconCache = new Map<string, FaviconCacheEntry>();

/** Test seam: the cache is process-wide and keyed by project path. */
export function resetProjectFaviconCache(): void {
  faviconCache.clear();
}

/**
 * Resolves a project-relative candidate, refusing anything that escapes the
 * project root. `iconPath` comes from a file that is typically checked in, so
 * a repository must not be able to aim it at `~/.ssh/id_rsa`.
 */
function resolveWithinProject(
  projectPath: string,
  relativePath: string,
): string | null {
  if (path.isAbsolute(relativePath)) {
    return null;
  }
  const absolutePath = path.resolve(projectPath, relativePath);
  const relative = path.relative(projectPath, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return absolutePath;
}

async function statFile(absolutePath: string): Promise<Stats | null> {
  try {
    const stats = await stat(absolutePath);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
}

type FaviconFile = {
  readonly absolutePath: string;
  readonly mimeType: string;
  readonly stats: Stats;
};

async function acceptCandidate(
  projectPath: string,
  relativePath: string,
): Promise<FaviconFile | null> {
  const absolutePath = resolveWithinProject(projectPath, relativePath);
  if (!absolutePath) {
    return null;
  }
  const mimeType = MIME_TYPES_BY_EXTENSION.get(
    path.extname(absolutePath).toLowerCase(),
  );
  if (!mimeType) {
    return null;
  }
  const stats = await statFile(absolutePath);
  if (!stats || stats.size === 0 || stats.size > MAX_FAVICON_BYTES) {
    return null;
  }
  return { absolutePath, mimeType, stats };
}

async function findFaviconFile(
  projectPath: string,
): Promise<FaviconFile | null> {
  const configuredPath = (await readProjectSettingsFile(projectPath))?.iconPath;
  if (configuredPath) {
    const configured = await acceptCandidate(projectPath, configuredPath);
    if (configured) {
      return configured;
    }
    // An explicit choice that goes nowhere is a mistake worth surfacing,
    // unlike the conventional paths below which are expected to miss.
    log.warn(
      `Project icon "${configuredPath}" from .agent-ui/settings.jsonc is not a readable image inside ${projectPath}`,
    );
  }

  for (const candidate of FAVICON_CANDIDATES) {
    const found = await acceptCandidate(projectPath, candidate);
    if (found) {
      return found;
    }
  }
  return null;
}

/**
 * Returns the project's icon as a base64 data URL, or `null` when it has none.
 *
 * Results are cached per project. A cached hit costs a single `stat` on the
 * resolved file — the candidate scan and the read only rerun once that file's
 * mtime or size moves, so editing a favicon shows up without a restart.
 */
export async function getProjectFaviconDataUrl(
  projectPath: string,
): Promise<string | null> {
  const cached = faviconCache.get(projectPath);
  if (cached?.resolvedPath === null) {
    if (Date.now() - cached.resolvedAt < MISSING_RESCAN_MS) {
      return null;
    }
  } else if (cached?.resolvedPath) {
    const stats = await statFile(cached.resolvedPath);
    if (stats?.mtimeMs === cached.mtimeMs && stats.size === cached.size) {
      return cached.dataUrl;
    }
  }

  const found = await findFaviconFile(projectPath);
  if (!found) {
    faviconCache.set(projectPath, {
      resolvedPath: null,
      mtimeMs: 0,
      size: 0,
      dataUrl: null,
      resolvedAt: Date.now(),
    });
    return null;
  }

  let content: Buffer;
  try {
    content = await readFile(found.absolutePath);
  } catch (error) {
    // Left uncached: a file we just stat-ed failing to read is transient.
    log.warn(`Failed to read project icon at ${found.absolutePath}:`, error);
    return null;
  }

  const dataUrl = `data:${found.mimeType};base64,${content.toString("base64")}`;
  faviconCache.set(projectPath, {
    resolvedPath: found.absolutePath,
    mtimeMs: found.stats.mtimeMs,
    size: found.stats.size,
    dataUrl,
    resolvedAt: Date.now(),
  });
  return dataUrl;
}
