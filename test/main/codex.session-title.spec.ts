import { describe, expect, it, vi } from "vitest";
import type { SessionTitleManager } from "../../src/main/session-title-manager";
import {
  type CodexLocalTerminalSessionData,
  CodexSessionsManager,
} from "../../src/main/sessions/codex.session";
import type { SessionServiceState } from "../../src/main/sessions/state";

function createSessionsState() {
  const state: Record<string, CodexLocalTerminalSessionData> = {};
  return {
    state,
    updateState: (updater: (draft: typeof state) => void) => {
      updater(state);
    },
  } as unknown as SessionServiceState;
}

function createManager() {
  const sessionsState = createSessionsState();
  const titleManager = {
    maybeGenerate: vi.fn(),
    forget: vi.fn(),
  };

  const manager = new CodexSessionsManager({
    state: sessionsState,
    titleManager: titleManager as unknown as SessionTitleManager,
  });

  return { manager, sessionsState, titleManager };
}

describe("CodexSessionsManager title generation", () => {
  it("triggers title generation for unnamed sessions with initial prompt", () => {
    const { manager, sessionsState, titleManager } = createManager();
    vi.mocked(titleManager.maybeGenerate).mockImplementation((params) => {
      params.onTitleReady("Generated title");
    });

    const sessionId = manager.createSession({
      cwd: "/tmp",
      sessionName: undefined,
      permissionMode: "default",
      modelReasoningEffort: "high",
      fastMode: false,
      initialPrompt: "  write release notes  ",
    });

    expect(titleManager.maybeGenerate).toHaveBeenCalledTimes(1);
    expect(titleManager.maybeGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        prompt: "write release notes",
      }),
    );

    const created = sessionsState.state[sessionId];
    expect(created?.title).toBe("Generated title");
    if (created?.type === "codex-local-terminal") {
      expect(created.startupConfig.initialPrompt).toBe("write release notes");
    }
  });

  it("does not trigger title generation for named sessions", () => {
    const { manager, titleManager } = createManager();

    manager.createSession({
      cwd: "/tmp",
      sessionName: "Custom Session",
      permissionMode: "default",
      modelReasoningEffort: "high",
      fastMode: false,
      initialPrompt: "write release notes",
    });

    expect(titleManager.maybeGenerate).not.toHaveBeenCalled();
  });

  it("strips /plan prefix before title generation", () => {
    const { manager, titleManager } = createManager();

    const sessionId = manager.createSession({
      cwd: "/tmp",
      sessionName: undefined,
      permissionMode: "default",
      modelReasoningEffort: "high",
      fastMode: false,
      initialPrompt: " /plan   draft implementation plan ",
    });

    expect(titleManager.maybeGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        prompt: "draft implementation plan",
      }),
    );
  });

  it("skips title generation when /plan has no body", () => {
    const { manager, titleManager } = createManager();

    manager.createSession({
      cwd: "/tmp",
      sessionName: undefined,
      permissionMode: "default",
      modelReasoningEffort: "high",
      fastMode: false,
      initialPrompt: "/plan   ",
    });

    expect(titleManager.maybeGenerate).not.toHaveBeenCalled();
  });

  it("forgets title trigger state when deleting session", async () => {
    const { manager, titleManager } = createManager();

    const sessionId = manager.createSession({
      cwd: "/tmp",
      sessionName: undefined,
      permissionMode: "default",
      modelReasoningEffort: "high",
      fastMode: false,
      initialPrompt: "Summarize open tasks",
    });

    await manager.deleteSession(sessionId);

    expect(titleManager.forget).toHaveBeenCalledWith(sessionId);
  });

  it("does not overwrite a manually renamed session when title generation resolves", () => {
    const { manager, sessionsState, titleManager } = createManager();
    let onTitleReady: ((title: string) => void) | undefined;

    vi.mocked(titleManager.maybeGenerate).mockImplementation((params) => {
      onTitleReady = params.onTitleReady;
    });

    const sessionId = manager.createSession({
      cwd: "/tmp",
      sessionName: undefined,
      permissionMode: "default",
      modelReasoningEffort: "high",
      fastMode: false,
      initialPrompt: "Summarize open tasks",
    });

    manager.renameSession(sessionId, "Manually renamed");
    onTitleReady?.("Generated title");

    expect(sessionsState.state[sessionId]?.title).toBe("Manually renamed");
    expect(titleManager.forget).toHaveBeenCalledWith(sessionId);
  });
});
