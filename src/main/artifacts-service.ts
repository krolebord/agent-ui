import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { defineServiceState } from "@shared/service-state";
import { HTML_RENDER_MAX_TITLE_LENGTH } from "@shared/visuals";
import simpleGit from "simple-git";
import { z } from "zod";
import { procedure } from "./orpc";
import { defineStatePersistence } from "./persistence-orchestrator";

export const artifactSchema = z.object({
  id: z.string(),
  kind: z.enum(["file", "visual"]).default("file"),
  sessionId: z.string(),
  path: z.string(),
  name: z.string(),
  description: z.string().optional(),
  size: z.number().nonnegative(),
  mimeType: z.string().optional(),
  createdAt: z.number(),
  available: z.boolean().default(true),
});

export type Artifact = z.infer<typeof artifactSchema>;

export const defineArtifactsState = () =>
  defineServiceState({
    key: "artifacts",
    defaults: {} as Record<string, Artifact>,
  });

export type ArtifactsState = ReturnType<typeof defineArtifactsState>;

export const defineArtifactsPersistence = (state: ArtifactsState) =>
  defineStatePersistence({
    serviceState: state,
    schema: z.record(z.string(), artifactSchema),
  });

const mimeTypesByExtension: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".cjs": "text/javascript",
  ".css": "text/css",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".jsonl": "text/plain",
  ".log": "text/plain",
  ".markdown": "text/markdown",
  ".md": "text/markdown",
  ".mjs": "text/javascript",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xml": "text/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".zip": "application/zip",
};

const TEXT_SNIFF_BYTES = 8192;

async function looksLikeText(filePath: string): Promise<boolean> {
  const file = await open(filePath, "r").catch(() => null);
  if (!file) return false;
  try {
    const buffer = Buffer.alloc(TEXT_SNIFF_BYTES);
    const { bytesRead } = await file.read(buffer, 0, TEXT_SNIFF_BYTES, 0);
    const sample = buffer.subarray(0, bytesRead);
    if (sample.includes(0)) return false;
    new TextDecoder("utf-8", { fatal: true }).decode(sample, {
      stream: bytesRead === TEXT_SNIFF_BYTES,
    });
    return true;
  } catch {
    return false;
  } finally {
    await file.close();
  }
}

async function inferMimeType(filePath: string): Promise<string | undefined> {
  const known = mimeTypesByExtension[path.extname(filePath).toLowerCase()];
  if (known) return known;
  return (await looksLikeText(filePath)) ? "text/plain" : undefined;
}

export type ArtifactLocation =
  | { kind: "app" }
  | { kind: "project"; projectPath: string; tracked: boolean }
  | { kind: "elsewhere" };

interface ArtifactsServiceOptions {
  visualsDir: string;
  screenshotDir: string;
  getProjectPaths?: () => string[];
  listTrackedFiles?: (
    projectPath: string,
    relativePaths: string[],
  ) => Promise<Set<string>>;
  trashFile?: (filePath: string) => Promise<void>;
  now?: () => number;
}

const SCREENSHOT_MAX_AGE_MS = 60 * 60_000;

function isInside(dir: string, filePath: string): boolean {
  const relative = path.relative(dir, path.resolve(filePath));
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

async function listTrackedFilesWithGit(
  projectPath: string,
  relativePaths: string[],
): Promise<Set<string>> {
  const output = await simpleGit(projectPath).raw([
    "ls-files",
    "-z",
    "--",
    ...relativePaths,
  ]);
  return new Set(output.split("\0").filter(Boolean));
}

export class ArtifactsService {
  private readonly visualsDir: string;

  constructor(
    readonly state: ArtifactsState,
    private readonly options: ArtifactsServiceOptions,
  ) {
    this.visualsDir = path.resolve(options.visualsDir);
  }

  async publish(input: {
    sessionId: string;
    cwd: string | null;
    filePath: string;
    name?: string;
    description?: string;
  }): Promise<Artifact> {
    const resolvedPath = path.resolve(
      input.cwd ?? process.cwd(),
      input.filePath,
    );
    const stats = await stat(resolvedPath);
    if (!stats.isFile()) {
      throw new Error("Only regular files can be published as artifacts");
    }
    const mimeType = await inferMimeType(resolvedPath);

    const existing = Object.values(this.state.state).find(
      (artifact) =>
        artifact.kind === "file" &&
        artifact.sessionId === input.sessionId &&
        artifact.path === resolvedPath,
    );
    if (existing) {
      this.state.updateState((artifacts) => {
        const draft = artifacts[existing.id];
        if (!draft) return;
        draft.name = input.name?.trim() || draft.name;
        draft.description = input.description?.trim() || draft.description;
        draft.size = stats.size;
        draft.mimeType = mimeType;
        draft.available = true;
      });
      return this.state.state[existing.id] ?? existing;
    }

    const artifact: Artifact = {
      id: randomUUID(),
      kind: "file",
      sessionId: input.sessionId,
      path: resolvedPath,
      name: input.name?.trim() || path.basename(resolvedPath),
      description: input.description?.trim() || undefined,
      size: stats.size,
      mimeType,
      createdAt: Date.now(),
      available: true,
    };

    this.state.updateState((artifacts) => {
      artifacts[artifact.id] = artifact;
    });
    return artifact;
  }

  async publishVisual(input: {
    sessionId: string;
    html: string;
    title: string;
    description?: string;
  }): Promise<Artifact> {
    const id = randomUUID();
    const filePath = path.join(this.visualsDir, `${id}.html`);
    await mkdir(this.visualsDir, { recursive: true });
    await writeFile(filePath, input.html, "utf8");

    const artifact: Artifact = {
      id,
      kind: "visual",
      sessionId: input.sessionId,
      path: filePath,
      name:
        input.title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH).trim() ||
        "Visual",
      description: input.description?.trim() || undefined,
      size: Buffer.byteLength(input.html, "utf8"),
      mimeType: "text/html",
      createdAt: Date.now(),
      available: true,
    };

    this.state.updateState((artifacts) => {
      artifacts[artifact.id] = artifact;
    });
    return artifact;
  }

  async remove(id: string): Promise<void> {
    const artifact = this.state.state[id];
    this.state.updateState((artifacts) => {
      delete artifacts[id];
    });
    if (
      artifact?.kind === "visual" &&
      isInside(this.visualsDir, artifact.path)
    ) {
      await rm(artifact.path, { force: true }).catch(() => {});
    }
  }

  async removeMany(ids: string[]): Promise<void> {
    for (const id of ids) await this.remove(id);
  }

  async inspect(ids: string[]): Promise<Record<string, ArtifactLocation>> {
    const projectPaths = (this.options.getProjectPaths?.() ?? [])
      .map((projectPath) => path.resolve(projectPath))
      .sort((a, b) => b.length - a.length);
    const listTrackedFiles =
      this.options.listTrackedFiles ?? listTrackedFilesWithGit;
    const locations: Record<string, ArtifactLocation> = {};
    const filesByProject = new Map<string, Map<string, string>>();

    for (const id of ids) {
      const artifact = this.state.state[id];
      if (!artifact) continue;
      if (
        artifact.kind === "visual" &&
        isInside(this.visualsDir, artifact.path)
      ) {
        locations[id] = { kind: "app" };
        continue;
      }
      const projectPath = projectPaths.find((candidate) =>
        isInside(candidate, artifact.path),
      );
      if (!projectPath) {
        locations[id] = { kind: "elsewhere" };
        continue;
      }
      locations[id] = { kind: "project", projectPath, tracked: false };
      const files = filesByProject.get(projectPath) ?? new Map();
      files.set(id, path.relative(projectPath, path.resolve(artifact.path)));
      filesByProject.set(projectPath, files);
    }

    await Promise.all(
      [...filesByProject].map(async ([projectPath, files]) => {
        const tracked = await listTrackedFiles(projectPath, [
          ...new Set(files.values()),
        ]).catch(() => new Set<string>());
        for (const [id, relativePath] of files) {
          const location = locations[id];
          if (location?.kind === "project")
            location.tracked = tracked.has(relativePath);
        }
      }),
    );
    return locations;
  }

  async cleanup(): Promise<{
    removedArtifacts: number;
    removedScreenshots: number;
  }> {
    await this.refreshAvailability();
    const missing = Object.values(this.state.state)
      .filter((artifact) => !artifact.available)
      .map((artifact) => artifact.id);
    await this.removeMany(missing);
    return {
      removedArtifacts: missing.length,
      removedScreenshots: await this.pruneScreenshots(),
    };
  }

  async deleteFiles(
    ids: string[],
  ): Promise<{ deleted: number; skipped: number }> {
    const locations = await this.inspect(ids);
    let deleted = 0;
    let skipped = 0;
    for (const id of ids) {
      const artifact = this.state.state[id];
      const location = locations[id];
      if (!artifact || !location) continue;
      if (location.kind === "app") {
        await this.remove(id);
        deleted += 1;
        continue;
      }
      if (location.kind === "project" && location.tracked) {
        skipped += 1;
        continue;
      }
      const stats = await lstat(artifact.path).catch(() => null);
      if (stats && !stats.isFile()) {
        skipped += 1;
        continue;
      }
      if (stats) {
        await (this.options.trashFile ?? ((filePath) => rm(filePath)))(
          artifact.path,
        );
      }
      this.state.updateState((artifacts) => {
        delete artifacts[id];
        for (const other of Object.values(artifacts)) {
          if (other.path === artifact.path) other.available = false;
        }
      });
      deleted += 1;
    }
    return { deleted, skipped };
  }

  private async pruneScreenshots(): Promise<number> {
    const dir = this.options.screenshotDir;
    const cutoff = (this.options.now ?? Date.now)() - SCREENSHOT_MAX_AGE_MS;
    const names = await readdir(dir).catch(() => []);
    let removed = 0;
    for (const name of names) {
      const filePath = path.join(dir, name);
      const stats = await lstat(filePath).catch(() => null);
      if (!stats?.isFile() || stats.mtimeMs > cutoff) continue;
      await rm(filePath, { force: true });
      removed += 1;
    }
    return removed;
  }

  async refreshAvailability(): Promise<void> {
    const artifacts = Object.values(this.state.state);
    const availability = await Promise.all(
      artifacts.map(async (artifact) => {
        const stats = await stat(artifact.path).catch(() => null);
        return [artifact.id, Boolean(stats?.isFile())] as const;
      }),
    );
    this.state.updateState((draft) => {
      for (const [id, available] of availability) {
        if (draft[id]) draft[id].available = available;
      }
    });
  }

  markUnavailable(id: string): void {
    this.state.updateState((artifacts) => {
      if (artifacts[id]) artifacts[id].available = false;
    });
  }
}

export const artifactsRouter = {
  refreshAvailability: procedure.handler(async ({ context }) => {
    await context.artifactsService.refreshAvailability();
  }),
  remove: procedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) => {
      await context.artifactsService.remove(input.id);
    }),
  removeMany: procedure
    .input(z.object({ ids: z.array(z.string()) }))
    .handler(async ({ input, context }) => {
      await context.artifactsService.removeMany(input.ids);
    }),
  inspect: procedure
    .input(z.object({ ids: z.array(z.string()) }))
    .handler(({ input, context }) =>
      context.artifactsService.inspect(input.ids),
    ),
  cleanup: procedure.handler(({ context }) =>
    context.artifactsService.cleanup(),
  ),
  deleteFiles: procedure
    .input(z.object({ ids: z.array(z.string()) }))
    .handler(({ input, context }) =>
      context.artifactsService.deleteFiles(input.ids),
    ),
  getDownloadUrl: procedure
    .input(z.object({ id: z.string() }))
    .handler(({ input, context }) => {
      if (!context.artifactsService.state.state[input.id]) {
        throw new Error("Artifact not found");
      }
      const webAppUrl = context.getWebAppUrl();
      if (!webAppUrl) {
        throw new Error("Artifact downloads are not available yet");
      }
      return {
        path: `/artifacts/${encodeURIComponent(input.id)}/download`,
        url: `${webAppUrl}/artifacts/${encodeURIComponent(input.id)}/download`,
      };
    }),
};
