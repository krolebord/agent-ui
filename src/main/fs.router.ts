import path from "node:path";
import { app, dialog, shell } from "electron";
import { z } from "zod";
import { procedure } from "./orpc";

export const fsRouter = {
  openFolder: procedure
    .input(z.object({ path: z.string().trim().min(1) }))
    .handler(async ({ input }) => {
      await shell.openPath(input.path);
    }),
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
  selectFolderWithOptions: procedure
    .input(
      z.object({
        title: z.string().trim().min(1).optional(),
        defaultPath: z.string().trim().min(1).optional(),
      }),
    )
    .handler(async ({ context, input }) => {
      const dialogOptions: Electron.OpenDialogOptions = {
        title: input.title ?? "Select Folder",
        defaultPath: input.defaultPath,
        properties: ["openDirectory", "createDirectory"],
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
  openDevTools: procedure.handler(async ({ context }) => {
    const mainWindow = context.getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
  }),
};
