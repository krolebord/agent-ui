// Adapted from t3code (https://github.com/pingdotgg/t3code), MIT, Copyright (c) 2026 T3 Tools Inc.
import { open, stat } from "node:fs/promises";

const MIB = 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * MIB;
export const MAX_PAGE_BYTES = 25 * MIB;

const formatMib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`;

export class VisualImageTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly sizeBytes: number,
    readonly maxBytes: number,
  ) {
    super(
      `${path} is ${formatMib(sizeBytes)}; each local image must be at most ${formatMib(maxBytes)}.`,
    );
    this.name = "VisualImageTooLargeError";
  }
}

export class VisualPageTooLargeError extends Error {
  constructor(
    readonly sizeBytes: number,
    readonly maxBytes: number,
  ) {
    super(
      `With its images inlined the page is ${formatMib(sizeBytes)}; the limit is ${formatMib(maxBytes)}. Use smaller images.`,
    );
    this.name = "VisualPageTooLargeError";
  }
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};
const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_TYPES).join("|");
// POSIX `/…` (not protocol-relative `//…`) or Windows `C:\…` / `C:/…`.
const ABSOLUTE_PATH = String.raw`(?:/(?!/)|[a-z]:[\\/])`;
// An absolute image path that is a whole quoted string ("…", '…', `…`) or an
// unquoted CSS url(…). URLs, data:, blob:, and relative paths never match.
const LOCAL_IMAGE_PATTERN = new RegExp(
  String.raw`(["'\x60])(${ABSOLUTE_PATH}(?:(?!\1)[^\r\n]){0,2048}?\.(?:${IMAGE_EXTENSIONS}))\1` +
    String.raw`|url\(\s*(${ABSOLUTE_PATH}[^\s"'\x60()]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))\s*\)`,
  "gid",
);

function findLocalImages(html: string) {
  return Array.from(html.matchAll(LOCAL_IMAGE_PATTERN)).flatMap((match) => {
    const span = match.indices?.[2] ?? match.indices?.[3];
    return span
      ? [{ start: span[0], end: span[1], path: html.slice(span[0], span[1]) }]
      : [];
  });
}

// Inside a JS string literal a Windows path's backslashes are escaped.
const filePathFor = (reference: string) =>
  /^[a-z]:/i.test(reference) ? reference.replaceAll("\\\\", "\\") : reference;

const dataUriPrefix = (path: string) =>
  `data:${IMAGE_MIME_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream"};base64,`;

const latin1 = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/**
 * Whether file bytes are an image, whatever the file is named, so a symlink or
 * renamed file cannot carry other data, such as a secret, into a page.
 */
function isImageBytes(bytes: Uint8Array): boolean {
  const head = latin1(bytes, 0, 12);
  if (
    head.startsWith("\x89PNG") ||
    head.startsWith("\xff\xd8\xff") ||
    head.startsWith("GIF8") ||
    head.startsWith("\0\0\x01\0") ||
    (head.startsWith("BM") && head.slice(6, 10) === "\0\0\0\0") ||
    (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") ||
    /^ftyp(?:avif|avis|mif1)$/.test(head.slice(4, 12))
  ) {
    return true;
  }
  return hasSvgRoot(new TextDecoder().decode(bytes.subarray(0, 4096)));
}

/** The index just past `token` at or after `from`, or -1 when it never appears. */
function after(text: string, token: string, from: number): number {
  const at = text.indexOf(token, from);
  return at === -1 ? -1 : at + token.length;
}

/**
 * Whether an XML document's root element is <svg>, after any processing
 * instructions, comments, and a doctype. One forward pass, so no input can
 * make it slow, and quoted text never counts as markup.
 */
function hasSvgRoot(text: string): boolean {
  let at = 0;
  while (at !== -1) {
    while (/\s/.test(text.charAt(at))) at += 1;
    if (text.startsWith("<?", at)) at = after(text, "?>", at + 2);
    else if (text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
    else if (text.slice(at, at + 9).toLowerCase() === "<!doctype")
      at = afterDoctype(text, at + 9);
    // XML names are case-sensitive, and only these characters can end one here.
    else return /^<svg[ \t\r\n/>]/.test(text.slice(at, at + 5));
  }
  return false;
}

/** The index just past a doctype whose body starts at `from`, honoring quotes and its internal subset. */
function afterDoctype(text: string, from: number): number {
  let inSubset = false;
  let at = from;
  while (at !== -1 && at < text.length) {
    const char = text[at];
    if (char === '"' || char === "'") at = after(text, char, at + 1);
    else if (inSubset && text.startsWith("<!--", at))
      at = after(text, "-->", at + 4);
    else if (inSubset && text.startsWith("<?", at))
      at = after(text, "?>", at + 2);
    else if (char === ">" && !inSubset) return at + 1;
    else {
      if (char === "[") inSubset = true;
      else if (char === "]") inSubset = false;
      at += 1;
    }
  }
  return -1;
}

const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

async function fileSize(filePath: string): Promise<number | undefined> {
  const info = await stat(filePath).catch(() => null);
  return info?.isFile() ? info.size : undefined;
}

/** Reads at most `limit` bytes, so a file that grew after `stat` cannot exhaust memory. */
async function readUpTo(
  filePath: string,
  limit: number,
): Promise<Uint8Array | undefined> {
  const handle = await open(filePath, "r").catch(() => null);
  if (!handle) return undefined;
  try {
    const buffer = Buffer.alloc(limit);
    let length = 0;
    while (length < limit) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        limit - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return buffer.subarray(0, length);
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return results;
}

/** Replaces every local image reference with a data URI; unreadable paths stay as written. */
export async function inlineLocalImages(
  html: string,
  limits: { maxImageBytes?: number; maxPageBytes?: number } = {},
): Promise<{ html: string; missingImages: string[] }> {
  const maxImageBytes = limits.maxImageBytes ?? MAX_IMAGE_BYTES;
  const maxPageBytes = limits.maxPageBytes ?? MAX_PAGE_BYTES;
  const references = findLocalImages(html);
  const paths = [...new Set(references.map((reference) => reference.path))];
  const files = await mapWithConcurrency(paths, 8, async (path) => ({
    path,
    size: await fileSize(filePathFor(path)),
  }));

  const oversized = files.find(
    (file) => file.size !== undefined && file.size > maxImageBytes,
  );
  if (oversized?.size !== undefined) {
    throw new VisualImageTooLargeError(
      oversized.path,
      oversized.size,
      maxImageBytes,
    );
  }
  const sizes = new Map(files.map((file) => [file.path, file.size]));
  const pageBytes = references.reduce((total, reference) => {
    const size = sizes.get(reference.path);
    return size === undefined
      ? total
      : total +
          dataUriPrefix(reference.path).length +
          base64Length(size) -
          Buffer.byteLength(reference.path);
  }, Buffer.byteLength(html));
  if (pageBytes > maxPageBytes) {
    throw new VisualPageTooLargeError(pageBytes, maxPageBytes);
  }

  let readBytes = 0;
  const images = await mapWithConcurrency(
    files.filter((file) => file.size !== undefined),
    4,
    async (file) => {
      const bytes = await readUpTo(filePathFor(file.path), maxImageBytes + 1);
      if (!bytes || !isImageBytes(bytes)) return null;
      if (bytes.byteLength > maxImageBytes) {
        throw new VisualImageTooLargeError(
          file.path,
          bytes.byteLength,
          maxImageBytes,
        );
      }
      readBytes += base64Length(bytes.byteLength);
      if (readBytes > maxPageBytes) {
        throw new VisualPageTooLargeError(readBytes, maxPageBytes);
      }
      return { path: file.path, bytes };
    },
  );

  const dataUris = new Map<string, string>();
  for (const image of images) {
    if (!image) continue;
    dataUris.set(
      image.path,
      dataUriPrefix(image.path) + Buffer.from(image.bytes).toString("base64"),
    );
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const reference of references) {
    const dataUri = dataUris.get(reference.path);
    if (dataUri === undefined) continue;
    parts.push(html.slice(cursor, reference.start), dataUri);
    cursor = reference.end;
  }
  parts.push(html.slice(cursor));
  const inlined = parts.join("");
  const inlinedBytes = Buffer.byteLength(inlined);
  if (inlinedBytes > maxPageBytes) {
    throw new VisualPageTooLargeError(inlinedBytes, maxPageBytes);
  }
  return {
    html: inlined,
    missingImages: paths.filter((path) => !dataUris.has(path)),
  };
}
