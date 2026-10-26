import { orpc } from "@renderer/orpc-client";
import {
  MAX_PASTED_FILE_BYTES,
  MAX_PASTED_FILE_MB,
} from "@shared/pasted-files";
import { useCallback } from "react";
import { toast } from "sonner";

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

type PastedFileUpload = (input: {
  base64Data: string;
  fileName?: string;
  mimeType?: string;
}) => Promise<{ filePath: string }>;

export async function uploadPastedFile(
  file: File,
  upload: PastedFileUpload,
): Promise<string | null> {
  if (file.size > MAX_PASTED_FILE_BYTES) {
    toast.error(`File is too large to attach (max ${MAX_PASTED_FILE_MB}MB)`);
    return null;
  }

  try {
    const base64Data = await readFileAsBase64(file);
    const { filePath } = await upload({
      base64Data,
      fileName: file.name || undefined,
      mimeType: file.type || undefined,
    });
    return filePath;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    toast.error(`Failed to attach file: ${message}`);
    return null;
  }
}

export function useTerminalFileUpload(terminalId: string) {
  return useCallback(
    (file: File) =>
      uploadPastedFile(file, (input) =>
        orpc.terminals.uploadPastedFile.call({ terminalId, ...input }),
      ),
    [terminalId],
  );
}
