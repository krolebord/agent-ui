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

// Matches ASCII control characters (0x00-0x1f and 0x7f) without embedding
// literal control bytes in the source.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the intent
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

// Used only to synthesize a name when the clipboard file has none (e.g. a
// screenshot pasted straight from the OS). Real files keep their own name.
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
  // basename() drops any directory component, defeating path traversal
  // (e.g. "../../etc/passwd" -> "passwd"). We then strip control chars and
  // stray separators, and collapse whitespace so the pasted path stays a
  // single unquoted token the CLI can parse.
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

  // Each file gets its own uuid subdirectory so the original name can be
  // preserved without collisions, and cleanup can drop the whole dir.
  const dir = path.join(getPastedFilesDir(), randomUUID());
  await mkdir(dir, { recursive: true });
  void cleanupExpiredPastedFiles();

  const filePath = path.join(dir, safeName);
  await writeFile(filePath, buffer);
  return { filePath };
}
