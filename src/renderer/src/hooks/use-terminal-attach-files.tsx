import { useTerminalFileUpload } from "@renderer/hooks/use-terminal-file-upload";
import { orpc } from "@renderer/orpc-client";
import { useRef } from "react";

/**
 * Owns the hidden file input and the attach flow shared by the mobile key bar
 * and the desktop session header: uploads each picked file to the host and
 * pastes the resulting paths into the terminal (space-separated), the same
 * tokens a drag-drop would produce.
 *
 * Render `fileInput` somewhere in the tree and call `openFilePicker` from the
 * attach button.
 */
export function useTerminalAttachFiles(terminalId: string) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadFile = useTerminalFileUpload(terminalId);

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  const handleFilesSelected = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) {
      return;
    }

    const paths = (
      await Promise.all(Array.from(fileList).map((file) => uploadFile(file)))
    ).filter((path): path is string => path != null);

    if (paths.length > 0) {
      await orpc.terminals.writeToTerminal.call({
        terminalId,
        data: `${paths.join(" ")} `,
      });
    }
  };

  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      multiple
      className="hidden"
      onChange={(event) => {
        void handleFilesSelected(event.target.files);
        // Reset so selecting the same file again re-triggers change.
        event.target.value = "";
      }}
    />
  );

  return { openFilePicker, fileInput };
}
