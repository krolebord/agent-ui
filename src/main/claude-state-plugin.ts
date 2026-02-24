import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { detectHookRuntime, type HookRuntime } from "./hook-runtime";
import log from "./logger";

const PLUGIN_VERSION = 1;

interface HookMatcherConfig {
  matcher?: string;
  hooks: Array<{
    type: "command";
    command: string;
    timeout: number;
  }>;
}

function buildHooksConfig(runtime: HookRuntime) {
  const commandHook = {
    type: "command" as const,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${CLAUDE_PLUGIN_ROOT} is a Claude CLI hook variable
    command: `${runtime} "${"${CLAUDE_PLUGIN_ROOT}"}/scripts/emit-state.mjs"`,
    timeout: 5,
  };

  const noMatcher = (): HookMatcherConfig => ({
    hooks: [commandHook],
  });

  const anyMatcher = (): HookMatcherConfig => ({
    matcher: "*",
    hooks: [commandHook],
  });

  return {
    description: "Emit Claude Code hook events to Claude UI.",
    hooks: {
      SessionStart: [noMatcher()],
      UserPromptSubmit: [noMatcher()],
      PreToolUse: [anyMatcher()],
      PostToolUse: [anyMatcher()],
      PermissionRequest: [anyMatcher()],
      Notification: [anyMatcher()],
      Stop: [noMatcher()],
      SessionEnd: [noMatcher()],
    },
  };
}

function buildPluginManifest() {
  return {
    name: "claude-ui-state-monitor",
    version: `${PLUGIN_VERSION}.0.0`,
    description:
      "Managed plugin that emits Claude Code hook lifecycle events for Claude UI state monitoring.",
    author: {
      name: "claude-ui",
    },
  };
}

function buildHookScript(runtime: HookRuntime) {
  return `#!/usr/bin/env ${runtime}
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const stateFilePath = process.env.CLAUDE_UI_STATE_FILE;
  if (!stateFilePath) {
    return;
  }

  const rawInput = await readStdin();
  if (!rawInput.trim()) {
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawInput);
  } catch {
    return;
  }

  if (!payload || typeof payload !== "object") {
    return;
  }

  if (
    typeof payload.hook_event_name !== "string" ||
    typeof payload.session_id !== "string"
  ) {
    return;
  }

  const normalized = {
    timestamp: new Date().toISOString(),
    session_id: payload.session_id,
    hook_event_name: payload.hook_event_name,
    cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
    prompt: typeof payload.prompt === "string" ? payload.prompt : undefined,
    transcript_path:
      typeof payload.transcript_path === "string"
        ? payload.transcript_path
        : undefined,
    notification_type:
      typeof payload.notification_type === "string"
        ? payload.notification_type
        : undefined,
    tool_name:
      typeof payload.tool_name === "string"
        ? payload.tool_name
        : undefined,
    reason: typeof payload.reason === "string" ? payload.reason : undefined,
    stop_hook_active:
      typeof payload.stop_hook_active === "boolean"
        ? payload.stop_hook_active
        : undefined,
  };

  await mkdir(path.dirname(stateFilePath), { recursive: true });
  await appendFile(stateFilePath, JSON.stringify(normalized) + "\\n", "utf8");
}

main().catch(() => {
  process.exit(0);
});
`;
}

export async function ensureManagedClaudeStatePlugin(
  userDataPath: string,
): Promise<string> {
  const pluginRoot = path.join(userDataPath, "claude-state-plugin");
  const pluginDir = path.join(pluginRoot, ".claude-plugin");
  const hooksDir = path.join(pluginRoot, "hooks");
  const scriptsDir = path.join(pluginRoot, "scripts");

  const runtime = await detectHookRuntime();

  await mkdir(pluginDir, { recursive: true });
  await mkdir(hooksDir, { recursive: true });
  await mkdir(scriptsDir, { recursive: true });

  const manifestPath = path.join(pluginDir, "plugin.json");
  const hooksPath = path.join(hooksDir, "hooks.json");
  const scriptPath = path.join(scriptsDir, "emit-state.mjs");

  await writeFile(
    manifestPath,
    `${JSON.stringify(buildPluginManifest(), null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    hooksPath,
    `${JSON.stringify(buildHooksConfig(runtime), null, 2)}\n`,
    "utf8",
  );
  await writeFile(scriptPath, buildHookScript(runtime), "utf8");

  if (process.platform !== "win32") {
    await chmod(scriptPath, 0o755);
  }

  log.info("Managed plugin created", { pluginRoot, runtime });
  return pluginRoot;
}
