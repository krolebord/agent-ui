import { app, type BrowserWindow, dialog, shell } from "electron";
import spawn from "nano-spawn";
import {
  type OpenInAppTarget,
  openInAppTargetLabels,
} from "../shared/open-in-app";
import type { AppHost, SelectDirectoryOptions } from "./app-host";

const macAppNames: Record<Exclude<OpenInAppTarget, "finder">, string> = {
  cursor: "Cursor",
  "github-desktop": "GitHub Desktop",
  terminal: "Terminal",
};

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "Unknown error";
}

interface CreateElectronHostOptions {
  getMainWindow: () => BrowserWindow | null;
}

export function createElectronHost(
  options: CreateElectronHostOptions,
): AppHost {
  return {
    mode: "electron",
    paths: {
      userData: app.getPath("userData"),
      logs: app.getPath("logs"),
    },
    desktop: {
      async openPath(targetPath) {
        const errorMessage = await shell.openPath(targetPath);
        if (errorMessage) {
          throw new Error(`Failed to open path: ${errorMessage}`);
        }
      },
      async openFolderInApp(targetPath, targetApp) {
        if (targetApp === "finder") {
          const errorMessage = await shell.openPath(targetPath);
          if (errorMessage) {
            throw new Error(
              `Failed to open folder in ${openInAppTargetLabels[targetApp]}: ${errorMessage}`,
            );
          }
          return;
        }

        try {
          await spawn("open", ["-a", macAppNames[targetApp], targetPath], {
            stdin: "ignore",
          });
        } catch (error) {
          throw new Error(
            `Failed to open folder in ${openInAppTargetLabels[targetApp]}: ${getErrorMessage(error)}`,
          );
        }
      },
      async selectDirectory(selectOptions: SelectDirectoryOptions) {
        const dialogOptions: Electron.OpenDialogOptions = {
          title: selectOptions.title,
          defaultPath: selectOptions.defaultPath,
          properties: selectOptions.canCreateDirectories
            ? ["openDirectory", "createDirectory"]
            : ["openDirectory"],
        };
        const mainWindow = options.getMainWindow();
        const result = mainWindow
          ? await dialog.showOpenDialog(mainWindow, dialogOptions)
          : await dialog.showOpenDialog(dialogOptions);

        if (result.canceled || result.filePaths.length === 0) {
          return null;
        }

        return result.filePaths[0] ?? null;
      },
      openDevTools() {
        options.getMainWindow()?.webContents.openDevTools({ mode: "detach" });
      },
    },
  };
}
