import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAX_PASTED_FILE_BYTES,
  MAX_PASTED_FILE_MB,
} from "../shared/pasted-files";

const PASTED_FILE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_NAME_LENGTH = 200;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the intent
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

const imageExtensionsByMimeType: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function getPastedFilesDir() {
  return path.join(os.tmpdir(), "agent-ui-pasted-files");
}

function sanitizeFileName(rawName: string | undefined, mimeType: string) {
  const cleaned = (rawName ? path.basename(rawName) : "")
    .replace(CONTROL_CHARS, "")
    .replace(/[\\/]/g, "")
    .replace(/\s+/g, "_")
    .trim();

  if (cleaned && cleaned !== "." && cleaned !== "..") {
    return cleaned.slice(0, MAX_FILE_NAME_LENGTH);
  }

  const extension = imageExtensionsByMimeType[mimeType] ?? "bin";
  return `pasted-file.${extension}`;
}

async function cleanupExpiredPastedFiles() {
  const root = getPastedFilesDir();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }

  const expiresBefore = Date.now() - PASTED_FILE_TTL_MS;
  await Promise.allSettled(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry);
      const stats = await stat(entryPath);
      if (stats.mtimeMs < expiresBefore) {
        await rm(entryPath, { recursive: true, force: true });
      }
    }),
  );
}

export async function savePastedFile({
  base64Data,
  fileName,
  mimeType = "",
}: {
  base64Data: string;
  fileName?: string;
  mimeType?: string;
}): Promise<{ filePath: string }> {
  const buffer = Buffer.from(base64Data, "base64");
  if (buffer.byteLength === 0) {
    throw new Error("Pasted file is empty");
  }
  if (buffer.byteLength > MAX_PASTED_FILE_BYTES) {
    throw new Error(`Pasted file is too large (max ${MAX_PASTED_FILE_MB}MB)`);
  }

  const safeName = sanitizeFileName(fileName, mimeType);

  const dir = path.join(getPastedFilesDir(), randomUUID());
  await mkdir(dir, { recursive: true });
  void cleanupExpiredPastedFiles();

  const filePath = path.join(dir, safeName);
  await writeFile(filePath, buffer);
  return { filePath };
}
