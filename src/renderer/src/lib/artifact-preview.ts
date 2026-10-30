import type { Artifact } from "@main/artifacts-service";
import type { FileContents } from "@pierre/diffs";
import { MAX_EDITABLE_ARTIFACT_BYTES } from "@shared/artifacts";

export type ArtifactPreviewKind = "image" | "pdf" | "html" | "text";

export const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;

export function getArtifactPreviewKind(
  mimeType: string | undefined,
): ArtifactPreviewKind | null {
  if (!mimeType) return null;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "text/html") return "html";
  if (mimeType.startsWith("text/") || mimeType === "application/json") {
    return "text";
  }
  return null;
}

// Never allow-same-origin: the frame must not reach the app's origin.
export function getHtmlPreviewSandbox(kind: Artifact["kind"]): string {
  return kind === "visual"
    ? "allow-scripts allow-popups allow-popups-to-escape-sandbox"
    : "";
}

const MIN_VISUAL_FRAME_HEIGHT = 120;

export function getVisualFrameHeight(
  contentHeight: number | undefined,
): string | undefined {
  if (contentHeight === undefined) return undefined;
  const height = Math.max(MIN_VISUAL_FRAME_HEIGHT, Math.ceil(contentHeight));
  return `min(${height}px, 70vh)`;
}

export function shouldToastNewArtifact(
  artifact: Pick<Artifact, "sessionId">,
  sessionInView: string | null,
): boolean {
  return artifact.sessionId !== sessionInView;
}

export function getNewArtifactToastTitle(
  artifact: Pick<Artifact, "kind" | "name">,
): string {
  return artifact.kind === "visual"
    ? `Visual ready: ${artifact.name}`
    : `Artifact created: ${artifact.name}`;
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

export function hasArtifactSourceView(
  artifact: Pick<Artifact, "kind" | "mimeType">,
): boolean {
  return (
    artifact.kind === "file" &&
    (artifact.mimeType === "image/svg+xml" || artifact.mimeType === "text/html")
  );
}

export function canEditArtifact(
  artifact: Pick<Artifact, "kind" | "available" | "size">,
  previewKind: ArtifactPreviewKind,
): boolean {
  return (
    artifact.kind === "file" &&
    artifact.available &&
    previewKind === "text" &&
    artifact.size <= MAX_EDITABLE_ARTIFACT_BYTES
  );
}

export function getTextPreviewFile(
  artifact: Pick<Artifact, "name" | "path" | "mimeType">,
  contents: string,
): FileContents {
  return {
    name: artifact.path.split(/[\\/]/).pop() || artifact.name,
    contents,
    lang: artifact.mimeType === "image/svg+xml" ? "xml" : undefined,
  };
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

export function getArtifactNavigation(
  ids: readonly string[],
  currentId: string,
): { index: number; previousId: string | null; nextId: string | null } {
  const index = ids.indexOf(currentId);
  if (index === -1) return { index, previousId: null, nextId: null };
  return {
    index,
    previousId: ids[index - 1] ?? null,
    nextId: ids[index + 1] ?? null,
  };
}
