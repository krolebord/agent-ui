import type { OpenInAppTarget } from "@shared/open-in-app";

export interface SelectDirectoryOptions {
  title: string;
  defaultPath?: string;
  canCreateDirectories?: boolean;
}

export interface DesktopHost {
  openPath(targetPath: string): Promise<void>;
  openFolderInApp(
    targetPath: string,
    targetApp: OpenInAppTarget,
  ): Promise<void>;
  selectDirectory(options: SelectDirectoryOptions): Promise<string | null>;
  openDevTools(): void;
}

export interface AppHost {
  mode: "electron" | "headless";
  paths: {
    userData: string;
    logs: string;
  };
  desktop: DesktopHost | null;
}
