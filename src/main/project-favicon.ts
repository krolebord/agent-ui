import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import log from "./logger";
import { readProjectSettingsFile } from "./project-settings-file";

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

const MAX_FAVICON_BYTES = 512 * 1024;

const MIN_SCAN_INTERVAL_MS = 15 * 60_000;

type FaviconCacheEntry = {
  readonly resolvedPath: string | null;
  readonly mimeType: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly dataUrl: string | null;
  readonly scannedAt: number;
};

const faviconCache = new Map<string, FaviconCacheEntry>();

export function resetProjectFaviconCache(): void {
  faviconCache.clear();
}

export function invalidateProjectFavicon(projectPath: string): void {
  faviconCache.delete(projectPath);
}

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
    const dataUrl = await readAsDataUrl({
      absolutePath: cached.resolvedPath,
      mimeType: cached.mimeType,
      stats,
    });
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
