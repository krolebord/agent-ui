import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PastedImageMimeType } from "../shared/pasted-images";

export const MAX_PASTED_IMAGE_BYTES = 15 * 1024 * 1024;
const PASTED_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;

const extensionsByMimeType: Record<PastedImageMimeType, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function getPastedImagesDir() {
  return path.join(os.tmpdir(), "agent-ui-pasted-images");
}

async function cleanupExpiredPastedImages(dir: string) {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  const expiresBefore = Date.now() - PASTED_IMAGE_TTL_MS;
  await Promise.allSettled(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry);
      const stats = await stat(entryPath);
      if (stats.isFile() && stats.mtimeMs < expiresBefore) {
        await unlink(entryPath);
      }
    }),
  );
}

export async function savePastedImage({
  base64Data,
  mimeType,
}: {
  base64Data: string;
  mimeType: PastedImageMimeType;
}): Promise<string> {
  const extension = extensionsByMimeType[mimeType];
  const buffer = Buffer.from(base64Data, "base64");
  if (buffer.byteLength === 0) {
    throw new Error("Pasted image is empty");
  }
  if (buffer.byteLength > MAX_PASTED_IMAGE_BYTES) {
    throw new Error(
      `Pasted image is too large (max ${Math.floor(MAX_PASTED_IMAGE_BYTES / (1024 * 1024))}MB)`,
    );
  }

  const dir = getPastedImagesDir();
  await mkdir(dir, { recursive: true });
  void cleanupExpiredPastedImages(dir);

  const filePath = path.join(dir, `pasted-image-${randomUUID()}.${extension}`);
  await writeFile(filePath, buffer);
  return filePath;
}
