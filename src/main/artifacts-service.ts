import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineServiceState } from "@shared/service-state";
import { HTML_RENDER_MAX_TITLE_LENGTH } from "@shared/visuals";
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
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".zip": "application/zip",
};

function inferMimeType(filePath: string): string | undefined {
  return mimeTypesByExtension[path.extname(filePath).toLowerCase()];
}

export class ArtifactsService {
  private readonly visualsDir: string;

  constructor(
    readonly state: ArtifactsState,
    options: { visualsDir: string },
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

    const artifact: Artifact = {
      id: randomUUID(),
      kind: "file",
      sessionId: input.sessionId,
      path: resolvedPath,
      name: input.name?.trim() || path.basename(resolvedPath),
      description: input.description?.trim() || undefined,
      size: stats.size,
      mimeType: inferMimeType(resolvedPath),
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
    if (artifact?.kind === "visual" && this.isInVisualsDir(artifact.path)) {
      await rm(artifact.path, { force: true }).catch(() => {});
    }
  }

  private isInVisualsDir(filePath: string): boolean {
    const relative = path.relative(this.visualsDir, path.resolve(filePath));
    return (
      relative !== "" &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative)
    );
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
