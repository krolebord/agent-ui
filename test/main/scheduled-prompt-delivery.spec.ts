import { createPromptDelivery } from "@main/scheduled-prompts/delivery";
import { claudeLocalTerminalSessionSchema } from "@main/session-service";
import { codexLocalTerminalSessionSchema } from "@main/sessions/codex.session";
import { cursorAgentSessionSchema } from "@main/sessions/cursor-agent.session";
import { defineSessionServiceState, type Session } from "@main/sessions/state";
import type { TerminalSessionStatus } from "@main/terminal-session";
import { describe, expect, it, vi } from "vitest";

function session(
  type: Session["type"],
  status: Session["status"] = "idle",
): Session {
  const common = {
    type,
    sessionId: "session",
    status,
    title: "Work",
    createdAt: 1,
    lastActivityAt: 1,
  };
  switch (type) {
    case "claude-local-terminal":
      return claudeLocalTerminalSessionSchema.parse({
        ...common,
        startupConfig: {
          cwd: "/var/tmp/project",
          model: "opus",
          permissionMode: "default",
        },
      });
    case "codex-local-terminal":
      return codexLocalTerminalSessionSchema.parse({
        ...common,
        codexSessionId: "thread",
        startupConfig: {
          cwd: "/var/tmp/project",
          permissionMode: "full-auto",
          modelReasoningEffort: "high",
        },
      });
    case "cursor-agent":
      return cursorAgentSessionSchema.parse({
        ...common,
        cursorChatId: "chat",
        initialPromptSent: true,
        startupConfig: {
          cwd: "/var/tmp/project",
          model: "auto",
          permissionMode: "default",
        },
      });
    default:
      throw new Error("Unsupported test session");
  }
}

function setup(target: Session) {
  const sessions = defineSessionServiceState();
  sessions.updateState((entries) => {
    entries[target.sessionId] = target;
  });
  const runtime: { status: TerminalSessionStatus } = { status: "running" };
  const getRuntime = vi.fn(
    (): { status: TerminalSessionStatus } | null => runtime,
  );
  const writeToTerminal = vi.fn();
  const resumeSession = vi.fn(async () => "session");
  const startCodex = vi.fn(async () => {});
  const startCursor = vi.fn(async () => {});
  const ensureFreshForPath = vi.fn(async () => {});
  const isProjectLocked = vi.fn(() => false);
  const deliver = createPromptDelivery({
    sessions,
    terminalManager: { getRuntime, writeToTerminal },
    claude: { resumeSession },
    codex: { startLiveSession: startCodex },
    cursor: { startLiveSession: startCursor },
    skills: { ensureFreshForPath },
    isProjectLocked,
  });
  return {
    sessions,
    runtime,
    getRuntime,
    writeToTerminal,
    resumeSession,
    startCodex,
    startCursor,
    ensureFreshForPath,
    isProjectLocked,
    deliver,
  };
}

describe("scheduled prompt delivery", () => {
  it.each([
    "claude-local-terminal",
    "codex-local-terminal",
    "cursor-agent",
  ] satisfies Session["type"][])(
    "pastes multiline text and submits it to a live %s session",
    async (type) => {
      const target = session(type);
      const { deliver, writeToTerminal, resumeSession } = setup(target);
      const result = deliver(target, "First line\r\nSecond line");
      expect(writeToTerminal).toHaveBeenCalledExactlyOnceWith(
        "session",
        "\x1b[200~First line\nSecond line\x1b[201~",
      );
      await result;
      expect(writeToTerminal.mock.calls[1]).toEqual([
        "session",
        type === "codex-local-terminal" ? "\x1b[13u" : "\r",
      ]);
      expect(resumeSession).not.toHaveBeenCalled();
    },
  );

  it("resumes Claude with a follow-up prompt in the same conversation", async () => {
    const target = session("claude-local-terminal", "stopped");
    const { deliver, resumeSession, ensureFreshForPath, writeToTerminal } =
      setup(target);
    await deliver(target, "Next task");
    expect(ensureFreshForPath).toHaveBeenCalledWith("/var/tmp/project");
    expect(resumeSession).toHaveBeenCalledWith(
      { sessionId: "session", cols: 120, rows: 36 },
      { prompt: "Next task" },
    );
    expect(writeToTerminal).not.toHaveBeenCalled();
  });

  it("resumes Codex with its existing thread and settings", async () => {
    const target = session("codex-local-terminal", "stopped");
    const { deliver, startCodex } = setup(target);
    await deliver(target, "Next task");
    expect(startCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session",
        codexSessionId: "thread",
        initialPrompt: "Next task",
        permissionMode: "full-auto",
        modelReasoningEffort: "high",
      }),
    );
  });

  it("resumes Cursor with its existing chat", async () => {
    const target = session("cursor-agent", "stopped");
    const { deliver, startCursor } = setup(target);
    await deliver(target, "Next task");
    expect(startCursor).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session",
        cursorChatId: "chat",
        initialPrompt: "Next task",
      }),
    );
  });

  it("rejects missing conversations, terminals, and busy projects", async () => {
    const codex = session("codex-local-terminal", "stopped");
    if (codex.type === "codex-local-terminal") delete codex.codexSessionId;
    const stopped = setup(codex);
    await expect(stopped.deliver(codex, "Next")).rejects.toThrow(
      "Start this session",
    );
    expect(stopped.startCodex).not.toHaveBeenCalled();
    const target = session("claude-local-terminal");
    const live = setup(target);
    live.getRuntime.mockReturnValue(null);
    await expect(live.deliver(target, "Next")).rejects.toThrow("unavailable");
    live.isProjectLocked.mockReturnValue(true);
    await expect(live.deliver(target, "Next")).rejects.toThrow(
      "Project is busy",
    );
    expect(live.writeToTerminal).not.toHaveBeenCalled();
  });

  it("does not submit if the terminal disappears after pasting", async () => {
    const target = session("claude-local-terminal");
    const { deliver, getRuntime, writeToTerminal } = setup(target);
    const result = deliver(target, "Next");
    getRuntime.mockReturnValue(null);
    await expect(result).rejects.toThrow("Session stopped while sending");
    expect(writeToTerminal).toHaveBeenCalledOnce();
  });

  it("does not resume after the session becomes busy during preparation", async () => {
    const target = session("claude-local-terminal", "stopped");
    const { deliver, sessions, ensureFreshForPath, resumeSession } =
      setup(target);
    ensureFreshForPath.mockImplementation(async () => {
      sessions.updateState((entries) => {
        entries.session.status = "running";
      });
    });
    await expect(deliver(target, "Next")).rejects.toThrow("Session changed");
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("does not submit if the agent becomes busy after pasting", async () => {
    const target = session("claude-local-terminal");
    const { deliver, sessions, writeToTerminal } = setup(target);
    const result = deliver(target, "Next");
    sessions.updateState((entries) => {
      entries.session.status = "running";
    });
    await expect(result).rejects.toThrow("Session became busy");
    expect(writeToTerminal).toHaveBeenCalledOnce();
  });
});
