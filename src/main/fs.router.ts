import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
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

export const browseDirectoriesInputSchema = z.object({
  partialPath: pathSchema,
  cwd: pathSchema.optional(),
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

function expandHomePath(input: string) {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function isExplicitRelativePath(input: string) {
  return (
    input === "." ||
    input === ".." ||
    input.startsWith("./") ||
    input.startsWith("../") ||
    input.startsWith(".\\") ||
    input.startsWith("..\\")
  );
}

function isPermissionDeniedError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

export async function browseDirectories({
  partialPath,
  cwd,
}: z.infer<typeof browseDirectoriesInputSchema>) {
  const inputPath = partialPath.trim();
  const basePath = cwd?.trim();
  const resolvedInputPath = isExplicitRelativePath(inputPath)
    ? path.resolve(expandHomePath(basePath ?? ""), inputPath)
    : path.resolve(expandHomePath(inputPath));

  const isDirectoryMode = /[\\/]$/.test(inputPath) || inputPath === "~";
  const parentPath = isDirectoryMode
    ? resolvedInputPath
    : path.dirname(resolvedInputPath);
  const prefix = isDirectoryMode ? "" : path.basename(resolvedInputPath);

  let dirents: Dirent<string>[];
  try {
    dirents = await readdir(parentPath, {
      encoding: "utf8",
      withFileTypes: true,
    });
  } catch (error) {
    if (isPermissionDeniedError(error)) {
      return { parentPath, entries: [] };
    }
    throw new Error(
      `Failed to browse folder "${parentPath}": ${getErrorMessage(error)}`,
    );
  }

  const lowerPrefix = prefix.toLowerCase();
  const showHidden = isDirectoryMode || prefix.startsWith(".");
  const entries = dirents
    .filter(
      (dirent) =>
        dirent.isDirectory() &&
        dirent.name.toLowerCase().startsWith(lowerPrefix) &&
        (showHidden || !dirent.name.startsWith(".")),
    )
    .map((dirent) => ({
      name: dirent.name,
      fullPath: path.join(parentPath, dirent.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return { parentPath, entries };
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
  browseDirectories: procedure
    .input(browseDirectoriesInputSchema)
    .handler(async ({ input }) => {
      return browseDirectories(input);
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
  openHandoffsFolder: procedure.handler(async () => {
    const handoffsDir = path.join(app.getPath("userData"), "handoffs");
    await shell.openPath(handoffsDir);
  }),
  openDevTools: procedure.handler(async ({ context }) => {
    const mainWindow = context.getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
  }),
};
