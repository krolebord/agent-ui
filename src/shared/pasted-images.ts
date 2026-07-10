export const supportedPastedImageMimeTypes = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type PastedImageMimeType =
  (typeof supportedPastedImageMimeTypes)[number];

export function isPastedImageMimeType(
  mimeType: string,
): mimeType is PastedImageMimeType {
  return (supportedPastedImageMimeTypes as readonly string[]).includes(
    mimeType,
  );
}
