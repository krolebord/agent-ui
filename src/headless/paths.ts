import os from "node:os";
import path from "node:path";

interface ResolveHeadlessPathsOptions {
  platform?: NodeJS.Platform;
  env?: Partial<NodeJS.ProcessEnv>;
  homeDir?: string;
  cwd?: string;
}

function resolveUserPath(input: string, homeDir: string, cwd: string) {
  if (input === "~") {
    return homeDir;
  }
  if (input.startsWith("~/")) {
    return path.join(homeDir, input.slice(2));
  }
  return path.resolve(cwd, input);
}

function getAbsoluteEnvPath(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed && path.isAbsolute(trimmed) ? trimmed : undefined;
}

export function resolveHeadlessPaths(
  options: ResolveHeadlessPathsOptions = {},
) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const configuredDataPath = env.AGENT_UI_DATA_DIR?.trim();

  if (configuredDataPath) {
    const userData = resolveUserPath(configuredDataPath, homeDir, cwd);
    return {
      userData,
      logs: path.join(userData, "logs"),
    };
  }

  if (platform === "darwin") {
    return {
      userData: path.join(
        homeDir,
        "Library",
        "Application Support",
        "agent-ui",
      ),
      logs: path.join(homeDir, "Library", "Logs", "agent-ui"),
    };
  }

  const configHome =
    getAbsoluteEnvPath(env.XDG_CONFIG_HOME) ?? path.join(homeDir, ".config");
  const stateHome =
    getAbsoluteEnvPath(env.XDG_STATE_HOME) ??
    path.join(homeDir, ".local", "state");

  return {
    userData: path.join(configHome, "agent-ui"),
    logs: path.join(stateHome, "agent-ui", "logs"),
  };
}
