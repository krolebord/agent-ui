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

/**
 * Uploads a file to the host (it can't travel through the PTY stream) and
 * returns the absolute path to paste into the terminal, or null on failure.
 * Shared by clipboard paste and the mobile attach button.
 */
export function useTerminalFileUpload(terminalId: string) {
  return useCallback(
    async (file: File): Promise<string | null> => {
      if (file.size > MAX_PASTED_FILE_BYTES) {
        toast.error(
          `File is too large to attach (max ${MAX_PASTED_FILE_MB}MB)`,
        );
        return null;
      }

      try {
        const base64Data = await readFileAsBase64(file);
        const { filePath } = await orpc.terminals.uploadPastedFile.call({
          terminalId,
          base64Data,
          fileName: file.name || undefined,
          mimeType: file.type || undefined,
        });
        return filePath;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        toast.error(`Failed to attach file: ${message}`);
        return null;
      }
    },
    [terminalId],
  );
}
