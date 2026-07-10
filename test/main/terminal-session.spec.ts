import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ptyMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onExit: vi.fn(() => ({ dispose: vi.fn() })),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
}));

vi.mock("node-pty", () => ({
  spawn: ptyMocks.spawn,
}));

import { createTerminalSession } from "../../src/main/terminal-session";

const originalShell = process.env.SHELL;

function createSession() {
  return createTerminalSession({
    onData: vi.fn(),
    onExit: vi.fn(),
    onStatusChange: vi.fn(),
  });
}

describe("createTerminalSession shell launch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SHELL = "/bin/bash";
    ptyMocks.spawn.mockReturnValue({
      onData: ptyMocks.onData,
      onExit: ptyMocks.onExit,
      write: ptyMocks.write,
      resize: ptyMocks.resize,
      kill: ptyMocks.kill,
    });
  });

  afterEach(() => {
    process.env.SHELL = originalShell;
  });

  it("loads the managed Bash configuration for project terminals", () => {
    createSession().start({
      runWithShell: true,
      cwd: "/tmp/project",
      env: { AGENT_UI_BASH_RCFILE: "/tmp/managed/.bashrc" },
    });

    expect(ptyMocks.spawn).toHaveBeenCalledWith(
      "/bin/bash",
      ["--rcfile", "/tmp/managed/.bashrc", "-i"],
      expect.objectContaining({ cwd: "/tmp/project" }),
    );
  });

  it("keeps login-shell behavior without managed Bash integration", () => {
    createSession().start({
      runWithShell: true,
      file: "codex",
      args: ["--version"],
      cwd: "/tmp/project",
    });

    expect(ptyMocks.spawn).toHaveBeenCalledWith(
      "/bin/bash",
      ["-ilc", "exec codex --version"],
      expect.objectContaining({ cwd: "/tmp/project" }),
    );
  });
});
