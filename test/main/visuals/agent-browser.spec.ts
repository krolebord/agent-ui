import type { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  AgentBrowserError,
  createAgentBrowserCli,
  detectAgentBrowser,
} from "../../../src/main/visuals/agent-browser";

interface FakeChild extends EventEmitter {
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

interface SpawnCall {
  file: string;
  args: string[];
  options: { cwd?: string };
  stdin: string;
  child: FakeChild;
}

function createFakeSpawn(
  behavior: (child: FakeChild, call: SpawnCall) => void,
) {
  const calls: SpawnCall[] = [];
  const spawn = vi.fn(
    (file: string, args: string[], options: { cwd?: string }) => {
      const child = new EventEmitter() as FakeChild;
      const call: SpawnCall = { file, args, options, stdin: "", child };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new Writable({
        write(chunk, _encoding, callback) {
          call.stdin += String(chunk);
          callback();
        },
      });
      child.kill = vi.fn(() => {
        queueMicrotask(() => child.emit("close", null));
        return true;
      });
      calls.push(call);
      queueMicrotask(() => behavior(child, call));
      return child;
    },
  );
  return { spawn: spawn as unknown as typeof nodeSpawn, calls };
}

function respond(child: FakeChild, stdout: string, exitCode = 0, stderr = "") {
  if (stdout) child.stdout.emit("data", stdout);
  if (stderr) child.stderr.emit("data", stderr);
  child.emit("close", exitCode);
}

function missingExecutable(child: FakeChild) {
  child.emit(
    "error",
    Object.assign(new Error("spawn agent-browser ENOENT"), { code: "ENOENT" }),
  );
}

describe("createAgentBrowserCli", () => {
  it("runs a bailing JSON batch in the fixed cwd with commands on stdin", async () => {
    const { spawn, calls } = createFakeSpawn((child) =>
      respond(
        child,
        JSON.stringify([
          {
            command: ["open", "http://example.test"],
            success: true,
            error: null,
            result: { url: "http://example.test" },
            extra: "ignored",
          },
          { command: ["console"], success: false, result: null },
        ]),
      ),
    );
    const runner = createAgentBrowserCli({ cwd: "/data/agent-ui", spawn });
    const commands = [["open", "http://example.test"], ["console"]];

    const results = await runner.batch("preview-1", commands, {
      timeoutMs: 1_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("agent-browser");
    expect(calls[0]?.args).toEqual([
      "--session",
      "preview-1",
      "--json",
      "batch",
      "--bail",
    ]);
    expect(calls[0]?.args).not.toContain("--no-sandbox");
    expect(calls[0]?.options.cwd).toBe("/data/agent-ui");
    expect(JSON.parse(calls[0]?.stdin ?? "")).toEqual(commands);
    expect(results).toEqual([
      {
        command: ["open", "http://example.test"],
        success: true,
        error: null,
        result: { url: "http://example.test" },
      },
      { command: ["console"], success: false, error: null, result: null },
    ]);
  });

  it("returns per-command failures from a bailed batch that exits non-zero", async () => {
    const { spawn } = createFakeSpawn((child) =>
      respond(
        child,
        JSON.stringify([
          {
            command: ["open", "x"],
            success: false,
            error: "net::ERR_FAILED",
            result: null,
          },
        ]),
        1,
      ),
    );
    const runner = createAgentBrowserCli({ cwd: "/tmp", spawn });

    await expect(
      runner.batch("s", [["open", "x"]], { timeoutMs: 1_000 }),
    ).resolves.toEqual([
      {
        command: ["open", "x"],
        success: false,
        error: "net::ERR_FAILED",
        result: null,
      },
    ]);
  });

  it("throws a top-level failure such as a launch error", async () => {
    const { spawn } = createFakeSpawn((child) =>
      respond(
        child,
        JSON.stringify({
          success: false,
          data: null,
          error: "Auto-launch failed: No usable sandbox!",
        }),
        1,
      ),
    );
    const runner = createAgentBrowserCli({ cwd: "/tmp", spawn });

    const batch = runner.batch("s", [["open", "x"]], { timeoutMs: 1_000 });
    await expect(batch).rejects.toBeInstanceOf(AgentBrowserError);
    await expect(batch).rejects.toThrow(
      "Auto-launch failed: No usable sandbox!",
    );
  });

  it("throws when the output is not JSON, including stderr", async () => {
    const { spawn } = createFakeSpawn((child) =>
      respond(child, "", 2, "daemon crashed"),
    );
    const runner = createAgentBrowserCli({ cwd: "/tmp", spawn });

    await expect(
      runner.batch("s", [["open", "x"]], { timeoutMs: 1_000 }),
    ).rejects.toThrow("daemon crashed");
  });

  it("throws when the output has an unexpected shape", async () => {
    const { spawn } = createFakeSpawn((child) =>
      respond(child, JSON.stringify([{ command: "open" }])),
    );
    const runner = createAgentBrowserCli({ cwd: "/tmp", spawn });

    await expect(
      runner.batch("s", [["open", "x"]], { timeoutMs: 1_000 }),
    ).rejects.toBeInstanceOf(AgentBrowserError);
  });

  it("kills the process when the batch times out", async () => {
    const { spawn, calls } = createFakeSpawn(() => {});
    const runner = createAgentBrowserCli({ cwd: "/tmp", spawn });

    await expect(
      runner.batch("s", [["open", "x"]], { timeoutMs: 10 }),
    ).rejects.toThrow("did not finish within 10ms");
    expect(calls[0]?.child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("closes a session and swallows failures", async () => {
    const { spawn, calls } = createFakeSpawn(missingExecutable);
    const runner = createAgentBrowserCli({
      cwd: "/tmp",
      executable: "/opt/agent-browser",
      spawn,
    });

    await expect(runner.close("preview-1")).resolves.toBeUndefined();
    expect(calls[0]?.file).toBe("/opt/agent-browser");
    expect(calls[0]?.args).toEqual(["--session", "preview-1", "close"]);
  });
});

describe("detectAgentBrowser", () => {
  it("reports the installed version", async () => {
    const { spawn, calls } = createFakeSpawn((child) =>
      respond(child, "agent-browser 0.37.1\n"),
    );

    await expect(detectAgentBrowser({ spawn })).resolves.toEqual({
      available: true,
      version: "0.37.1",
    });
    expect(calls[0]?.args).toEqual(["--version"]);
  });

  it("reports a missing executable", async () => {
    const { spawn } = createFakeSpawn(missingExecutable);

    await expect(detectAgentBrowser({ spawn })).resolves.toEqual({
      available: false,
      error: "agent-browser is not installed or not on PATH",
    });
  });

  it("reports unexpected version output", async () => {
    const { spawn } = createFakeSpawn((child) => respond(child, "nope", 1));

    await expect(detectAgentBrowser({ spawn })).resolves.toMatchObject({
      available: false,
      error: expect.stringContaining("nope"),
    });
  });
});
