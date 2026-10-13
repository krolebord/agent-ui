import { spawn as nodeSpawn } from "node:child_process";
import { z } from "zod";

export type AgentBrowserStatus =
  | { available: true; version: string }
  | { available: false; error: string };

const commandResultSchema = z.object({
  command: z.array(z.string()),
  success: z.boolean(),
  error: z.string().nullable().default(null),
  result: z.unknown(),
});

export type AgentBrowserCommandResult = z.infer<typeof commandResultSchema>;

const batchFailureSchema = z.object({
  success: z.literal(false),
  error: z.string(),
});

export interface AgentBrowserRunner {
  batch(
    session: string,
    commands: string[][],
    options: { timeoutMs: number },
  ): Promise<AgentBrowserCommandResult[]>;
  close(session: string): Promise<void>;
}

export class AgentBrowserError extends Error {
  override name = "AgentBrowserError";
}

type Spawn = typeof nodeSpawn;

const DEFAULT_EXECUTABLE = "agent-browser";
const DETECT_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 10_000;

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

function run(
  spawn: Spawn,
  executable: string,
  args: string[],
  options: { cwd?: string; stdin?: string; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.stdin ?? "");
  });
}

function isMissingExecutable(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

export async function detectAgentBrowser(
  options: { executable?: string; spawn?: Spawn } = {},
): Promise<AgentBrowserStatus> {
  try {
    const { stdout, exitCode, timedOut } = await run(
      options.spawn ?? nodeSpawn,
      options.executable ?? DEFAULT_EXECUTABLE,
      ["--version"],
      { timeoutMs: DETECT_TIMEOUT_MS },
    );
    if (timedOut) {
      return { available: false, error: "agent-browser --version timed out" };
    }
    const version = /agent-browser\s+(\S+)/u.exec(stdout)?.[1];
    if (exitCode !== 0 || !version) {
      return {
        available: false,
        error: `Unexpected agent-browser --version output: ${stdout.trim() || `exit code ${exitCode}`}`,
      };
    }
    return { available: true, version };
  } catch (error) {
    if (isMissingExecutable(error)) {
      return {
        available: false,
        error: "agent-browser is not installed or not on PATH",
      };
    }
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseBatchOutput(output: RunResult): AgentBrowserCommandResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.stdout);
  } catch {
    const detail = output.stderr.trim() || output.stdout.trim();
    throw new AgentBrowserError(
      `agent-browser returned no JSON (exit code ${output.exitCode})${detail ? `: ${detail.slice(-2000)}` : ""}`,
    );
  }
  const failure = batchFailureSchema.safeParse(parsed);
  if (failure.success) {
    throw new AgentBrowserError(failure.data.error);
  }
  const results = z.array(commandResultSchema).safeParse(parsed);
  if (!results.success) {
    throw new AgentBrowserError(
      `Unexpected agent-browser batch output: ${z.prettifyError(results.error)}`,
    );
  }
  return results.data;
}

export function createAgentBrowserCli(options: {
  cwd: string;
  executable?: string;
  spawn?: Spawn;
}): AgentBrowserRunner {
  const spawn = options.spawn ?? nodeSpawn;
  const executable = options.executable ?? DEFAULT_EXECUTABLE;

  return {
    async batch(session, commands, { timeoutMs }) {
      const output = await run(
        spawn,
        executable,
        ["--session", session, "--json", "batch", "--bail"],
        { cwd: options.cwd, stdin: JSON.stringify(commands), timeoutMs },
      );
      if (output.timedOut) {
        throw new AgentBrowserError(
          `agent-browser did not finish within ${timeoutMs}ms`,
        );
      }
      return parseBatchOutput(output);
    },
    async close(session) {
      await run(spawn, executable, ["--session", session, "close"], {
        cwd: options.cwd,
        timeoutMs: CLOSE_TIMEOUT_MS,
      }).catch(() => undefined);
    },
  };
}
