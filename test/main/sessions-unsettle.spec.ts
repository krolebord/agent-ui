import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "../../src/main/create-services";
import { sessionsRouter } from "../../src/main/orpc-router";
import type { ClaudeLocalTerminalSessionData } from "../../src/main/session-service";
import type { CodexLocalTerminalSessionData } from "../../src/main/sessions/codex.session";
import type { CursorAgentSessionData } from "../../src/main/sessions/cursor-agent.session";
import type { LocalTerminalSessionData } from "../../src/main/sessions/local-terminal.session";
import type {
  Session,
  SessionServiceState,
} from "../../src/main/sessions/state";
import type { WorktreeSetupSessionData } from "../../src/main/sessions/worktree-setup.session";

const NOW = 10_000;

function settledFields() {
  return {
    createdAt: 1,
    lastActivityAt: 1_000,
    settledAt: 1_000,
    settledOverride: "settled" as const,
    status: "stopped" as const,
  };
}

function claudeSession(
  overrides: Partial<ClaudeLocalTerminalSessionData> = {},
): ClaudeLocalTerminalSessionData {
  return {
    sessionId: "claude-1",
    type: "claude-local-terminal",
    title: "Claude",
    startupConfig: {
      cwd: "/proj/claude",
      permissionMode: "default",
      model: "opus",
      initialPrompt: undefined,
    },
    ...settledFields(),
    ...overrides,
  };
}

function localTerminalSession(
  overrides: Partial<LocalTerminalSessionData> = {},
): LocalTerminalSessionData {
  return {
    sessionId: "term-1",
    type: "local-terminal",
    title: "Terminal",
    startupConfig: { cwd: "/proj/term" },
    ...settledFields(),
    ...overrides,
  };
}

function codexSession(
  overrides: Partial<CodexLocalTerminalSessionData> = {},
): CodexLocalTerminalSessionData {
  return {
    sessionId: "codex-1",
    type: "codex-local-terminal",
    title: "Codex",
    startupConfig: {
      cwd: "/proj/codex",
      modelReasoningEffort: "high",
      permissionMode: "default",
    },
    ...settledFields(),
    ...overrides,
  };
}

function cursorSession(
  overrides: Partial<CursorAgentSessionData> = {},
): CursorAgentSessionData {
  return {
    sessionId: "cursor-1",
    type: "cursor-agent",
    title: "Cursor",
    startupConfig: {
      cwd: "/proj/cursor",
      permissionMode: "default",
      initialPrompt: undefined,
    },
    ...settledFields(),
    ...overrides,
  };
}

function worktreeSession(
  overrides: Partial<WorktreeSetupSessionData> = {},
): WorktreeSetupSessionData {
  return {
    sessionId: "wt-1",
    type: "worktree-setup",
    title: "Worktree setup",
    startupConfig: { cwd: "/proj/wt", projectRoot: "/proj/root" },
    steps: [],
    ...settledFields(),
    ...overrides,
  };
}

function buildContext(session?: Session) {
  const sessionsMap: Record<string, Session> = session
    ? { [session.sessionId]: { ...session } }
    : {};
  const resumeSession = vi.fn(async (input: { sessionId: string }) => {
    return input.sessionId;
  });
  const startLocal = vi.fn(async () => undefined);
  const startCodex = vi.fn(async () => undefined);
  const startCursor = vi.fn(async () => undefined);
  const ensureFreshForPath = vi.fn(async () => undefined);

  const context = {
    skillsService: { ensureFreshForPath },
    sessionsService: { resumeSession },
    sessions: {
      state: {
        state: sessionsMap,
        updateState: (updater: (draft: typeof sessionsMap) => void) => {
          updater(sessionsMap);
        },
      } as unknown as SessionServiceState,
      localTerminal: { startLiveSession: startLocal },
      codex: { startLiveSession: startCodex },
      cursorAgent: { startLiveSession: startCursor },
    },
  } as unknown as Services;

  return {
    context,
    sessionsMap,
    resumeSession,
    startLocal,
    startCodex,
    startCursor,
    ensureFreshForPath,
  };
}

async function unsettle(
  context: Services,
  sessionId: string,
  size?: { cols: number; rows: number },
) {
  await call(sessionsRouter.unsettle, { sessionId, ...size }, { context });
}

describe("sessions.unsettle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("puts a settled Claude session at the top and starts it", async () => {
    const session = claudeSession();
    const { context, sessionsMap, resumeSession, ensureFreshForPath } =
      buildContext(session);

    await unsettle(context, session.sessionId, { cols: 120, rows: 40 });

    expect(sessionsMap[session.sessionId]).toMatchObject({
      createdAt: NOW,
      lastActivityAt: NOW,
    });
    expect(sessionsMap[session.sessionId]?.settledAt).toBeUndefined();
    expect(sessionsMap[session.sessionId]?.settledOverride).toBeUndefined();
    expect(ensureFreshForPath).toHaveBeenCalledWith("/proj/claude");
    expect(resumeSession).toHaveBeenCalledWith({
      sessionId: session.sessionId,
      cols: 120,
      rows: 40,
    });
  });

  it("starts a settled local terminal", async () => {
    const session = localTerminalSession();
    const { context, startLocal, resumeSession } = buildContext(session);

    await unsettle(context, session.sessionId, { cols: 80, rows: 24 });

    expect(resumeSession).not.toHaveBeenCalled();
    expect(startLocal).toHaveBeenCalledWith({
      sessionId: session.sessionId,
      cwd: "/proj/term",
      cols: 80,
      rows: 24,
    });
  });

  it("starts a settled Codex session", async () => {
    const session = codexSession();
    const { context, startCodex } = buildContext(session);

    await unsettle(context, session.sessionId);

    expect(startCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.sessionId,
        cwd: "/proj/codex",
      }),
    );
  });

  it("starts a settled Cursor session", async () => {
    const session = cursorSession();
    const { context, startCursor } = buildContext(session);

    await unsettle(context, session.sessionId);

    expect(startCursor).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.sessionId,
        cwd: "/proj/cursor",
      }),
    );
  });

  it("does not start worktree setup, but still promotes it", async () => {
    const session = worktreeSession();
    const {
      context,
      sessionsMap,
      resumeSession,
      startLocal,
      startCodex,
      startCursor,
    } = buildContext(session);

    await unsettle(context, session.sessionId);

    expect(sessionsMap[session.sessionId]).toMatchObject({
      createdAt: NOW,
      lastActivityAt: NOW,
    });
    expect(sessionsMap[session.sessionId]?.settledOverride).toBeUndefined();
    expect(resumeSession).not.toHaveBeenCalled();
    expect(startLocal).not.toHaveBeenCalled();
    expect(startCodex).not.toHaveBeenCalled();
    expect(startCursor).not.toHaveBeenCalled();
  });

  it("no-ops when the session is not settled", async () => {
    const session = claudeSession({
      settledAt: undefined,
      settledOverride: undefined,
    });
    const { context, sessionsMap, resumeSession } = buildContext(session);

    await unsettle(context, session.sessionId);

    expect(sessionsMap[session.sessionId]?.createdAt).toBe(1);
    expect(sessionsMap[session.sessionId]?.lastActivityAt).toBe(1_000);
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("no-ops when the session is missing", async () => {
    const { context, resumeSession } = buildContext();

    await unsettle(context, "missing");

    expect(resumeSession).not.toHaveBeenCalled();
  });
});
