export type ArtifactPreviewKind = "image" | "pdf" | "text";

export const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;

export function getArtifactPreviewKind(
  mimeType: string | undefined,
): ArtifactPreviewKind | null {
  if (!mimeType) return null;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("text/") || mimeType === "application/json") {
    return "text";
  }
  return null;
}

export async function readTextPreview(
  response: Response,
  maxBytes = MAX_TEXT_PREVIEW_BYTES,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - bytesRead;
    if (value.byteLength > remaining) {
      text += decoder.decode(value.subarray(0, remaining));
      await reader.cancel();
      return { text, truncated: true };
    }
    bytesRead += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode(), truncated: false };
}

export function formatTextPreview(
  text: string,
  mimeType: string | undefined,
): string {
  if (mimeType !== "application/json") return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
