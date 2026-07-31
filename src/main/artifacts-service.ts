import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { defineServiceState } from "@shared/service-state";
import { z } from "zod";
import { procedure } from "./orpc";
import { defineStatePersistence } from "./persistence-orchestrator";

export const artifactSchema = z.object({
  id: z.string(),
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
  constructor(readonly state: ArtifactsState) {}

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

  remove(id: string): void {
    this.state.updateState((artifacts) => {
      delete artifacts[id];
    });
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
    .handler(({ input, context }) => {
      context.artifactsService.remove(input.id);
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
