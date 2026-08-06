import { beforeEach, describe, expect, it, vi } from "vitest";

type ExitPayload = {
  exitCode: number | null;
  stoppedByUser: boolean;
};

const terminalSessions = vi.hoisted(() => {
  const instances: Array<{
    callbacks: {
      onExit: (payload: ExitPayload) => Promise<void> | void;
      onStatusChange: (status: string) => void;
    };
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    bufferedOutput: string;
    resolveStop: () => void;
    exit: (payload?: ExitPayload) => Promise<void>;
  }> = [];

  return { instances };
});

vi.mock("../../src/main/terminal-session", () => ({
  createTerminalSession: vi.fn().mockImplementation((callbacks) => {
    let resolveStop!: () => void;
    const stopPromise = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    const instance = {
      callbacks,
      start: vi.fn(),
      stop: vi.fn(() => stopPromise),
      write: vi.fn(),
      resize: vi.fn(),
      clear: vi.fn(),
      bufferedOutput: "",
      resolveStop,
      exit: async (
        payload: ExitPayload = {
          exitCode: 0,
          stoppedByUser: true,
        },
      ) => {
        await callbacks.onExit(payload);
        resolveStop();
      },
    };
    terminalSessions.instances.push(instance);
    return instance;
  }),
}));

import { TerminalManager } from "../../src/main/terminal-manager";

const launch = {
  runWithShell: true as const,
  cwd: "/tmp/project",
};

describe("TerminalManager lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalSessions.instances.length = 0;
  });

  it("keeps routing to a terminal while its stop is pending", async () => {
    const manager = new TerminalManager();
    const runtime = await manager.startTerminal({
      terminalId: "terminal-1",
      launch,
    });

    const stopPromise = manager.stopTerminal("terminal-1");
    expect(manager.getRuntime("terminal-1")).toBe(runtime);

    manager.writeToTerminal("terminal-1", "\x03");
    expect(terminalSessions.instances[0]?.write).toHaveBeenCalledWith("\x03");

    await terminalSessions.instances[0]?.exit();
    await stopPromise;
    expect(manager.getRuntime("terminal-1")).toBeNull();
  });

  it("waits for a stopping terminal before creating one same-ID replacement", async () => {
    const manager = new TerminalManager();
    await manager.startTerminal({ terminalId: "terminal-1", launch });
    const stopPromise = manager.stopTerminal("terminal-1");

    const restartPromise = manager.startTerminal({
      terminalId: "terminal-1",
      launch,
    });
    expect(terminalSessions.instances).toHaveLength(1);

    await terminalSessions.instances[0]?.exit();
    await stopPromise;
    const replacement = await restartPromise;

    expect(terminalSessions.instances).toHaveLength(2);
    expect(manager.getRuntime("terminal-1")).toBe(replacement);
  });

  it("does not let an old exit callback delete a replacement", async () => {
    const manager = new TerminalManager();
    await manager.startTerminal({ terminalId: "terminal-1", launch });
    const oldSession = terminalSessions.instances[0];
    const stopPromise = manager.stopTerminal("terminal-1");
    const restartPromise = manager.startTerminal({
      terminalId: "terminal-1",
      launch,
    });

    await oldSession?.exit();
    await stopPromise;
    const replacement = await restartPromise;
    await oldSession?.callbacks.onExit({
      exitCode: 0,
      stoppedByUser: true,
    });

    expect(manager.getRuntime("terminal-1")).toBe(replacement);
  });
});
