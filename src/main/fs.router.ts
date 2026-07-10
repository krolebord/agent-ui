import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { openInAppTargetSchema } from "../shared/open-in-app";
import type { AppHost, DesktopHost } from "./app-host";
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

function requireDesktopHost(host: AppHost): DesktopHost {
  if (!host.desktop) {
    throw new ORPCError("METHOD_NOT_SUPPORTED", {
      message: "This operation is only available in the Electron app.",
    });
  }
  return host.desktop;
}

export const fsRouter = {
  openFolder: procedure
    .input(z.object({ path: pathSchema }))
    .handler(async ({ context, input }) => {
      await requireDesktopHost(context.host).openPath(input.path);
    }),
  openFolderInApp: procedure
    .input(openFolderInAppInputSchema)
    .handler(async ({ context, input }) => {
      await requireDesktopHost(context.host).openFolderInApp(
        input.path,
        input.app,
      );
    }),
  browseDirectories: procedure
    .input(browseDirectoriesInputSchema)
    .handler(async ({ input }) => {
      return browseDirectories(input);
    }),
  selectFolder: procedure.handler(async ({ context }) => {
    return await requireDesktopHost(context.host).selectDirectory({
      title: "Select Project Folder",
    });
  }),
  selectFolderWithOptions: procedure
    .input(
      z.object({
        title: z.string().trim().min(1).optional(),
        defaultPath: z.string().trim().min(1).optional(),
      }),
    )
    .handler(async ({ context, input }) => {
      return await requireDesktopHost(context.host).selectDirectory({
        title: input.title ?? "Select Folder",
        defaultPath: input.defaultPath,
        canCreateDirectories: true,
      });
    }),
  openLogFolder: procedure.handler(async ({ context }) => {
    await requireDesktopHost(context.host).openPath(context.host.paths.logs);
  }),
  openStatePluginFolder: procedure.handler(async ({ context }) => {
    const pluginPath = path.join(
      context.host.paths.userData,
      "claude-state-plugin",
    );
    await requireDesktopHost(context.host).openPath(pluginPath);
  }),
  openSessionFilesFolder: procedure.handler(async ({ context }) => {
    const stateDir = path.join(context.host.paths.userData, "claude-state");
    await requireDesktopHost(context.host).openPath(stateDir);
  }),
  openHandoffsFolder: procedure.handler(async ({ context }) => {
    const handoffsDir = path.join(context.host.paths.userData, "handoffs");
    await requireDesktopHost(context.host).openPath(handoffsDir);
  }),
  openDevTools: procedure.handler(async ({ context }) => {
    requireDesktopHost(context.host).openDevTools();
  }),
};
