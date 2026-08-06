import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("nano-spawn", () => ({
  default: spawnMock,
}));

import type spawn from "nano-spawn";
import { defineSessionServiceState } from "../../src/main/sessions/state";
import {
  WORKTREE_SETUP_MAX_OUTPUT_CHARS,
  WorktreeSetupSessionsManager,
} from "../../src/main/sessions/worktree-setup.session";

function createMockSubprocess(lines: string[]): ReturnType<typeof spawn> {
  const result = Promise.resolve({
    stdout: lines.join("\n"),
    stderr: "",
    output: lines.join("\n"),
    command: "",
    durationMs: 0,
  });

  return Object.assign(result, {
    async *[Symbol.asyncIterator]() {
      for (const line of lines) {
        yield line;
      }
    },
  }) as unknown as ReturnType<typeof spawn>;
}

function createMockSubprocessThrow(message: string): ReturnType<typeof spawn> {
  const err = new Error(message);
  const result = Promise.resolve({
    stdout: "",
    stderr: "",
    output: "",
    command: "",
    durationMs: 0,
  });

  return Object.assign(result, {
    // biome-ignore lint/correctness/useYield: mock subprocess fails before any line
    async *[Symbol.asyncIterator]() {
      throw err;
    },
  }) as unknown as ReturnType<typeof spawn>;
}

describe("WorktreeSetupSessionsManager", () => {
  let disposeController: AbortController;

  beforeEach(() => {
    vi.clearAllMocks();
    disposeController = new AbortController();
  });

  afterEach(() => {
    disposeController.abort();
  });

  it("runs setup commands sequentially with correct env vars", async () => {
    spawnMock.mockImplementation((command: string, opts: { env?: object }) => {
      expect(opts).toMatchObject({
        shell: true,
        cwd: "/wt",
        env: expect.objectContaining({
          PROJECT_ROOT: "/src",
          WORKTREE_ROOT: "/wt",
        }),
      });
      return createMockSubprocess([`out:${command}`]);
    });

    const sessionsState = defineSessionServiceState();
    const manager = new WorktreeSetupSessionsManager(
      sessionsState,
      disposeController.signal,
    );

    const sessionId = manager.createSessionAndStart({
      cwd: "/wt",
      projectRoot: "/src",
      commands: ["pnpm install", "pnpm build"],
    });

    await vi.waitFor(
      () => {
        const s = sessionsState.state[sessionId];
        expect(
          s?.type === "worktree-setup" && s.status === "awaiting_user_response",
        ).toBe(true);
      },
      { timeout: 3000 },
    );

    const session = sessionsState.state[sessionId];
    if (session?.type !== "worktree-setup") {
      throw new Error("expected worktree-setup session");
    }

    expect(session.steps.map((x) => x.status)).toEqual(["success", "success"]);
    expect(session.steps[0]?.output).toContain("out:pnpm install");
    expect(session.steps[1]?.output).toContain("out:pnpm build");
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("stops after a command failure", async () => {
    spawnMock
      .mockImplementationOnce(() => createMockSubprocess(["ok"]))
      .mockImplementationOnce(() => createMockSubprocessThrow("build failed"));

    const sessionsState = defineSessionServiceState();
    const manager = new WorktreeSetupSessionsManager(
      sessionsState,
      disposeController.signal,
    );

    const sessionId = manager.createSessionAndStart({
      cwd: "/wt",
      projectRoot: "/src",
      commands: ["a", "b", "c"],
    });

    await vi.waitFor(
      () => {
        const s = sessionsState.state[sessionId];
        expect(s?.type === "worktree-setup" && s.status === "error").toBe(true);
      },
      { timeout: 3000 },
    );

    const session = sessionsState.state[sessionId];
    if (session?.type !== "worktree-setup") {
      throw new Error("expected worktree-setup session");
    }

    expect(session.steps.map((x) => x.status)).toEqual([
      "success",
      "error",
      "pending",
    ]);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("truncates output at the configured max length", async () => {
    const longLine = "x".repeat(WORKTREE_SETUP_MAX_OUTPUT_CHARS + 500);
    spawnMock.mockImplementation(() => createMockSubprocess([longLine]));

    const sessionsState = defineSessionServiceState();
    const manager = new WorktreeSetupSessionsManager(
      sessionsState,
      disposeController.signal,
    );

    const sessionId = manager.createSessionAndStart({
      cwd: "/wt",
      projectRoot: "/src",
      commands: ["echo"],
    });

    await vi.waitFor(
      () => {
        const s = sessionsState.state[sessionId];
        expect(
          s?.type === "worktree-setup" && s.status === "awaiting_user_response",
        ).toBe(true);
      },
      { timeout: 3000 },
    );

    const session = sessionsState.state[sessionId];
    if (session?.type !== "worktree-setup") {
      throw new Error("expected worktree-setup session");
    }

    expect(session.steps[0]?.output.length).toBeLessThanOrEqual(
      WORKTREE_SETUP_MAX_OUTPUT_CHARS,
    );
    expect(session.steps[0]?.output).toContain("… [truncated]");
    expect(session.steps[0]?.outputTruncated).toBe(true);
  });
});
