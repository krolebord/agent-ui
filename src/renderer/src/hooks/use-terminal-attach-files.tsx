import { useTerminalFileUpload } from "@renderer/hooks/use-terminal-file-upload";
import { orpc } from "@renderer/orpc-client";
import { useRef } from "react";

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
        event.target.value = "";
      }}
    />
  );

  return { openFilePicker, fileInput };
}
