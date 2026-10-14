import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "../../src/main/create-services";
import { createInMemorySessionBufferStore } from "../../src/main/database/session-buffer-store";
import { sessionsRouter } from "../../src/main/orpc-router";
import type { ClaudeLocalTerminalSessionData } from "../../src/main/session-service";
import {
  type CodexLocalTerminalSessionData,
  codexSessionsRouter,
} from "../../src/main/sessions/codex.session";
import {
  type CursorAgentSessionData,
  cursorAgentSessionsRouter,
} from "../../src/main/sessions/cursor-agent.session";
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
  const sessionBuffers = createInMemorySessionBufferStore();

  const context = {
    sessionBuffers,
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
    sessionBuffers,
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

describe("session initial prompt access", () => {
  it("fetches prompts on demand and never reads orphaned or absent prompts", async () => {
    const session = claudeSession({ hasInitialPrompt: true });
    const { context, sessionsMap, sessionBuffers } = buildContext(session);
    await sessionBuffers.setInitialPrompt(session.sessionId, "saved prompt");
    const read = vi.spyOn(sessionBuffers, "getInitialPrompt");
    await expect(
      call(
        sessionsRouter.getInitialPrompt,
        { sessionId: session.sessionId },
        { context },
      ),
    ).resolves.toBe("saved prompt");
    expect(sessionsMap[session.sessionId]?.startupConfig).not.toHaveProperty(
      "initialPrompt",
    );
    await expect(
      call(
        sessionsRouter.getInitialPrompt,
        { sessionId: "missing" },
        { context },
      ),
    ).resolves.toBeUndefined();
    sessionsMap[session.sessionId] = claudeSession({ hasInitialPrompt: false });
    await expect(
      call(
        sessionsRouter.getInitialPrompt,
        { sessionId: session.sessionId },
        { context },
      ),
    ).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads Codex prompts only until the native session exists", async () => {
    const session = codexSession({ hasInitialPrompt: true });
    const { context, sessionsMap, sessionBuffers, startCodex } =
      buildContext(session);
    await sessionBuffers.setInitialPrompt(
      session.sessionId,
      "/plan saved prompt",
    );
    const read = vi.spyOn(sessionBuffers, "getInitialPrompt");
    await call(
      codexSessionsRouter.resumeSession,
      { sessionId: session.sessionId },
      { context },
    );
    expect(startCodex).toHaveBeenLastCalledWith(
      expect.objectContaining({ initialPrompt: "/plan saved prompt" }),
    );
    sessionsMap[session.sessionId] = codexSession({
      hasInitialPrompt: true,
      codexSessionId: "native-thread",
    });
    await call(
      codexSessionsRouter.resumeSession,
      { sessionId: session.sessionId },
      { context },
    );
    expect(startCodex).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialPrompt: undefined,
        codexSessionId: "native-thread",
      }),
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads pending Cursor prompts and preserves plan mode without resending delivered prompts", async () => {
    const session = cursorSession({
      hasInitialPrompt: true,
      initialPromptSent: false,
    });
    const { context, sessionsMap, sessionBuffers, startCursor } =
      buildContext(session);
    await sessionBuffers.setInitialPrompt(
      session.sessionId,
      "/plan saved prompt",
    );
    const read = vi.spyOn(sessionBuffers, "getInitialPrompt");
    await call(
      cursorAgentSessionsRouter.resumeSession,
      { sessionId: session.sessionId },
      { context },
    );
    expect(startCursor).toHaveBeenLastCalledWith(
      expect.objectContaining({ initialPrompt: "saved prompt", plan: true }),
    );
    sessionsMap[session.sessionId] = cursorSession({
      hasInitialPrompt: true,
      initialPromptSent: true,
    });
    await call(
      cursorAgentSessionsRouter.resumeSession,
      { sessionId: session.sessionId },
      { context },
    );
    expect(startCursor).toHaveBeenLastCalledWith(
      expect.objectContaining({ initialPrompt: undefined, plan: false }),
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("fails pending launches when SQLite cannot read the prompt", async () => {
    const session = codexSession({ hasInitialPrompt: true });
    const { context, sessionBuffers, startCodex } = buildContext(session);
    vi.spyOn(sessionBuffers, "getInitialPrompt").mockRejectedValue(
      new Error("database unavailable"),
    );
    await expect(
      call(
        codexSessionsRouter.resumeSession,
        { sessionId: session.sessionId },
        { context },
      ),
    ).rejects.toThrow("database unavailable");
    expect(startCodex).not.toHaveBeenCalled();
  });
});
