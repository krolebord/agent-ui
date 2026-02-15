import path from "node:path";
import { app, dialog, shell } from "electron";
import { procedure } from "./orpc";

export const fsRouter = {
  selectFolder: procedure.handler(async ({ context }) => {
    const dialogOptions: Electron.OpenDialogOptions = {
      title: "Select Project Folder",
      properties: ["openDirectory"],
    };
    const mainWindow = context.getMainWindow();
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0] ?? null;
  }),
  openLogFolder: procedure.handler(async () => {
    const logPath = app.getPath("logs");
    await shell.openPath(logPath);
  }),
  openStatePluginFolder: procedure.handler(async () => {
    const pluginPath = path.join(
      app.getPath("userData"),
      "claude-state-plugin",
    );
    await shell.openPath(pluginPath);
  }),
  openSessionFilesFolder: procedure.handler(async () => {
    const stateDir = path.join(app.getPath("userData"), "claude-state");
    await shell.openPath(stateDir);
  }),
};
