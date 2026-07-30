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

/**
 * Floor on how often a project's candidate list is walked. Between scans we
 * still re-stat the icon we already found, so edits to a known icon show up at
 * once — it is only *discovery* (gaining, moving or losing an icon) that waits.
 */
const MIN_SCAN_INTERVAL_MS = 15 * 60_000;

type FaviconCacheEntry = {
  /** `null` once a scan found nothing usable. */
  readonly resolvedPath: string | null;
  readonly mimeType: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly dataUrl: string | null;
  /** When the candidate scan behind this entry ran. */
  readonly scannedAt: number;
};

const faviconCache = new Map<string, FaviconCacheEntry>();

/** Test seam: the cache is process-wide and keyed by project path. */
export function resetProjectFaviconCache(): void {
  faviconCache.clear();
}

/**
 * Drops a project's scan cooldown so the next request rescans immediately.
 * Backs the manual "Refresh project icon" action, which exists precisely
 * because the cooldown is long enough to be worth overriding by hand.
 */
export function invalidateProjectFavicon(projectPath: string): void {
  faviconCache.delete(projectPath);
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

async function readAsDataUrl(file: FaviconFile): Promise<string | null> {
  try {
    const content = await readFile(file.absolutePath);
    return `data:${file.mimeType};base64,${content.toString("base64")}`;
  } catch (error) {
    log.warn(`Failed to read project icon at ${file.absolutePath}:`, error);
    return null;
  }
}

/**
 * Returns the project's icon as a base64 data URL, or `null` when it has none.
 *
 * Results are cached per project, and the candidate scan behind a cached entry
 * runs at most once every {@link MIN_SCAN_INTERVAL_MS}. Within that window a
 * request costs a single `stat` on the already-resolved icon: unchanged serves
 * the cached data URL, a changed mtime or size re-reads it, and a file that
 * disappeared reports no icon until the next scan is due. `Refresh project
 * icon` in the project menu clears the cooldown when the wait is too long.
 */
export async function getProjectFaviconDataUrl(
  projectPath: string,
): Promise<string | null> {
  const cached = faviconCache.get(projectPath);
  if (cached && Date.now() - cached.scannedAt < MIN_SCAN_INTERVAL_MS) {
    if (!cached.resolvedPath) {
      return null;
    }
    const stats = await statFile(cached.resolvedPath);
    if (!stats) {
      return null;
    }
    if (stats.mtimeMs === cached.mtimeMs && stats.size === cached.size) {
      return cached.dataUrl;
    }
    // Same file, new bytes: re-read without disturbing the scan cooldown, so
    // an icon being iterated on updates as fast as the UI asks for it.
    const dataUrl = await readAsDataUrl({
      absolutePath: cached.resolvedPath,
      mimeType: cached.mimeType,
      stats,
    });
    // A read that fails right after a successful stat is transient, so the
    // entry keeps its old mtime and the next request tries again.
    if (dataUrl === null) {
      return null;
    }
    faviconCache.set(projectPath, {
      ...cached,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      dataUrl,
    });
    return dataUrl;
  }

  const scannedAt = Date.now();
  const found = await findFaviconFile(projectPath);
  if (!found) {
    faviconCache.set(projectPath, {
      resolvedPath: null,
      mimeType: "",
      mtimeMs: 0,
      size: 0,
      dataUrl: null,
      scannedAt,
    });
    return null;
  }

  const dataUrl = await readAsDataUrl(found);
  if (dataUrl === null) {
    return null;
  }
  faviconCache.set(projectPath, {
    resolvedPath: found.absolutePath,
    mimeType: found.mimeType,
    mtimeMs: found.stats.mtimeMs,
    size: found.stats.size,
    dataUrl,
    scannedAt,
  });
  return dataUrl;
}
