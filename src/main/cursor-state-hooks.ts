import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { type ParseError, parse } from "jsonc-parser";
import { detectHookRuntime, type HookRuntime } from "./hook-runtime";
import log from "./logger";

const HOOK_CONFIG_VERSION = 1;

interface ManagedCursorHooks {
  configDir: string;
  eventsFilePath: string;
}

type HookConfigEntry = {
  command: string;
  timeout: number;
};

type HookConfig = {
  version?: number;
  hooks?: Record<string, unknown[]>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isHookConfigEntry(value: unknown): value is HookConfigEntry {
  return (
    isRecord(value) &&
    typeof value.command === "string" &&
    typeof value.timeout === "number"
  );
}

function buildHookCommand(runtime: HookRuntime, scriptPath: string): string {
  return `${runtime} "${scriptPath}"`;
}

function buildHooksConfig(
  runtime: HookRuntime,
  scriptPath: string,
): HookConfig {
  const command = buildHookCommand(runtime, scriptPath);
  const hook = { command, timeout: 5 };
  return {
    version: HOOK_CONFIG_VERSION,
    hooks: {
      sessionStart: [hook],
      sessionEnd: [hook],
      preToolUse: [hook],
      postToolUse: [hook],
      postToolUseFailure: [hook],
      beforeShellExecution: [hook],
      afterShellExecution: [hook],
      beforeMCPExecution: [hook],
      afterMCPExecution: [hook],
      beforeReadFile: [hook],
      afterFileEdit: [hook],
      beforeSubmitPrompt: [hook],
      afterAgentResponse: [hook],
      stop: [hook],
    },
  };
}

function parseHooksConfig(raw: string, filePath: string): HookConfig {
  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (errors.length > 0 || !isRecord(parsed)) {
    throw new Error(`Invalid Cursor hooks config at ${filePath}`);
  }

  const hooks = parsed.hooks;
  if (hooks !== undefined && !isRecord(hooks)) {
    throw new Error(`Invalid Cursor hooks config at ${filePath}`);
  }

  return parsed as HookConfig;
}

async function upsertManagedUserHooksConfig(
  userHooksPath: string,
  managedHooksConfig: HookConfig,
  managedScriptPath: string,
): Promise<void> {
  await mkdir(path.dirname(userHooksPath), { recursive: true });

  let nextConfig: HookConfig = {};
  try {
    const raw = await readFile(userHooksPath, "utf8");
    nextConfig = parseHooksConfig(raw, userHooksPath);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !(error as NodeJS.ErrnoException).code ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }

  const nextHooks: Record<string, unknown[]> = {};
  if (isRecord(nextConfig.hooks)) {
    for (const [hookName, hookEntries] of Object.entries(nextConfig.hooks)) {
      nextHooks[hookName] = Array.isArray(hookEntries) ? [...hookEntries] : [];
    }
  }

  for (const [hookName, managedHookEntries] of Object.entries(
    managedHooksConfig.hooks ?? {},
  )) {
    const managedEntries = managedHookEntries.filter(isHookConfigEntry);
    const preservedEntries = (nextHooks[hookName] ?? []).filter((entry) => {
      if (!isRecord(entry) || typeof entry.command !== "string") {
        return true;
      }
      // Match by script path so runtime changes (node→bun) replace the old entry
      return !entry.command.includes(managedScriptPath);
    });

    nextHooks[hookName] = [...preservedEntries, ...managedEntries];
  }

  nextConfig.version =
    typeof nextConfig.version === "number"
      ? nextConfig.version
      : HOOK_CONFIG_VERSION;
  nextConfig.hooks = nextHooks;

  await writeFile(
    userHooksPath,
    `${JSON.stringify(nextConfig, null, 2)}\n`,
    "utf8",
  );
}

function buildHookScript(runtime: HookRuntime, eventsFilePath: string): string {
  const escapedEventsFilePath = JSON.stringify(eventsFilePath);
  return `#!/usr/bin/env ${runtime}
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const eventsFilePath = ${escapedEventsFilePath};

function readStdin() {
  return new Promise((resolve, reject) => {
    let content = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      content += chunk;
    });
    process.stdin.on("end", () => resolve(content));
    process.stdin.on("error", reject);
  });
}

function defaultResponse() {
  return {
    continue: true,
    decision: "allow",
    permission: "allow",
  };
}

function buildHookResponse(hookEventName) {
  switch (hookEventName) {
    case "beforeShellExecution":
    case "beforeMCPExecution":
    case "beforeReadFile":
    case "beforeTabFileRead":
      return { permission: "allow" };
    case "preToolUse":
    case "subagentStart":
      return { decision: "allow" };
    case "sessionStart":
    case "beforeSubmitPrompt":
      return { continue: true };
    default:
      return {};
  }
}

function normalizeEvent(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const hookEventName =
    typeof payload.hook_event_name === "string" ? payload.hook_event_name : null;
  if (!hookEventName) {
    return null;
  }

  const normalized = {
    timestamp: new Date().toISOString(),
    hook_event_name: hookEventName,
    conversation_id:
      typeof payload.conversation_id === "string"
        ? payload.conversation_id
        : undefined,
    session_id:
      typeof payload.session_id === "string" ? payload.session_id : undefined,
    generation_id:
      typeof payload.generation_id === "string"
        ? payload.generation_id
        : undefined,
    tool_name: typeof payload.tool_name === "string" ? payload.tool_name : undefined,
    failure_type:
      typeof payload.failure_type === "string" ? payload.failure_type : undefined,
    status: typeof payload.status === "string" ? payload.status : undefined,
    reason: typeof payload.reason === "string" ? payload.reason : undefined,
    final_status:
      typeof payload.final_status === "string" ? payload.final_status : undefined,
    command: typeof payload.command === "string" ? payload.command : undefined,
    cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
    composer_mode:
      typeof payload.composer_mode === "string" ? payload.composer_mode : undefined,
    permission:
      typeof payload.permission === "string" ? payload.permission : undefined,
    decision: typeof payload.decision === "string" ? payload.decision : undefined,
    is_background_agent:
      typeof payload.is_background_agent === "boolean"
        ? payload.is_background_agent
        : undefined,
  };

  if (!normalized.conversation_id && normalized.session_id) {
    normalized.conversation_id = normalized.session_id;
  }

  return normalized;
}

async function main() {
  const rawInput = await readStdin();
  let payload = null;
  try {
    payload = rawInput.trim() ? JSON.parse(rawInput) : null;
  } catch {
    payload = null;
  }

  const normalizedEvent = normalizeEvent(payload);
  if (normalizedEvent) {
    await mkdir(path.dirname(eventsFilePath), { recursive: true });
    await appendFile(eventsFilePath, JSON.stringify(normalizedEvent) + "\\n", "utf8");
  }

  const hookEventName =
    payload && typeof payload === "object" && typeof payload.hook_event_name === "string"
      ? payload.hook_event_name
      : undefined;
  process.stdout.write(
    JSON.stringify(buildHookResponse(hookEventName) ?? defaultResponse()) + "\\n",
  );
}

main().catch(() => {
  process.stdout.write(JSON.stringify(defaultResponse()) + "\\n");
});
`;
}

async function copyUserCliConfigIfPresent(configDir: string): Promise<void> {
  const source = path.join(homedir(), ".cursor", "cli-config.json");
  const destination = path.join(configDir, "cli-config.json");

  try {
    await copyFile(source, destination);
  } catch {
    // Best effort only: sessions can still run with the managed defaults.
  }
}

export async function ensureManagedCursorStateHooks(
  userDataPath: string,
): Promise<ManagedCursorHooks> {
  const root = path.join(userDataPath, "cursor-hooks");
  const configDir = path.join(root, "config");
  const hooksDir = path.join(configDir, "hooks");
  const stateDir = path.join(root, "state");
  const scriptPath = path.join(hooksDir, "emit-state.mjs");
  const hooksPath = path.join(configDir, "hooks.json");
  const eventsFilePath = path.join(stateDir, "events.ndjson");

  const runtime = await detectHookRuntime();

  await mkdir(hooksDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  await writeFile(scriptPath, buildHookScript(runtime, eventsFilePath), "utf8");
  if (process.platform !== "win32") {
    await chmod(scriptPath, 0o755);
  }

  const hooksConfig = buildHooksConfig(runtime, scriptPath);
  await writeFile(
    hooksPath,
    `${JSON.stringify(hooksConfig, null, 2)}\n`,
    "utf8",
  );
  await upsertManagedUserHooksConfig(
    path.join(homedir(), ".cursor", "hooks.json"),
    hooksConfig,
    scriptPath,
  );
  await copyUserCliConfigIfPresent(configDir);

  try {
    await readFile(eventsFilePath, "utf8");
  } catch {
    await writeFile(eventsFilePath, "", "utf8");
  }

  log.info("Managed Cursor hooks created", {
    configDir,
    eventsFilePath,
    runtime,
  });

  return {
    configDir,
    eventsFilePath,
  };
}
