import path from "node:path";
import { app, dialog, shell } from "electron";
import spawn from "nano-spawn";
import { z } from "zod";
import {
  type OpenInAppTarget,
  openInAppTargetLabels,
  openInAppTargetSchema,
} from "../shared/open-in-app";
import { procedure } from "./orpc";

const pathSchema = z.string().trim().min(1);

export const openFolderInAppInputSchema = z.object({
  path: pathSchema,
  app: openInAppTargetSchema,
});

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

export async function openFolderInApp({
  path: targetPath,
  app: targetApp,
}: z.infer<typeof openFolderInAppInputSchema>) {
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
}

export const fsRouter = {
  openFolder: procedure
    .input(z.object({ path: pathSchema }))
    .handler(async ({ input }) => {
      await shell.openPath(input.path);
    }),
  openFolderInApp: procedure
    .input(openFolderInAppInputSchema)
    .handler(async ({ input }) => {
      await openFolderInApp(input);
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
