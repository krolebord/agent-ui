import { describe, expect, it, vi } from "vitest";
import {
  type CodexLocalTerminalSessionData,
  CodexSessionsManager,
} from "../../src/main/sessions/codex.session";
import type { SessionServiceState } from "../../src/main/sessions/state";
import type { TitleGenerationService } from "../../src/main/title-generation-service";
import {
  deriveProvisionalTitleFromPrompt,
  isAutoManagedSessionTitle,
} from "../../src/shared/title-generation";

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
  const titleGeneration = {
    requestFromPrompt: vi.fn(),
    forget: vi.fn(),
  };

  const manager = new CodexSessionsManager({
    state: sessionsState,
    titleGeneration: titleGeneration as unknown as TitleGenerationService,
  });

  return { manager, sessionsState, titleGeneration };
}

function mockTitleGeneration(
  titleGeneration: { requestFromPrompt: ReturnType<typeof vi.fn> },
  options?: { generatedTitle?: string },
) {
  vi.mocked(titleGeneration.requestFromPrompt).mockImplementation((params) => {
    const provisional = deriveProvisionalTitleFromPrompt(params.prompt);
    if (provisional) {
      params.setTitle(provisional);
    }
    if (options?.generatedTitle) {
      params.setTitle(options.generatedTitle);
    }
  });
}

describe("CodexSessionsManager title generation", () => {
  it("triggers title generation for unnamed sessions with initial prompt", () => {
    const { manager, sessionsState, titleGeneration } = createManager();
    mockTitleGeneration(titleGeneration, {
      generatedTitle: "Generated title",
    });

    const sessionId = manager.createSession({
      cwd: "/tmp",
      sessionName: undefined,
      permissionMode: "default",
      modelReasoningEffort: "high",
      fastMode: "off",
      initialPrompt: "  write release notes  ",
    });

    expect(titleGeneration.requestFromPrompt).toHaveBeenCalledTimes(1);
    expect(titleGeneration.requestFromPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        prompt: "write release notes",
        defaultTitle: "Codex Session",
      }),
    );

    const created = sessionsState.state[sessionId];
    expect(created?.title).toBe("Generated title");
    if (created?.type === "codex-local-terminal") {
      expect(created.startupConfig.initialPrompt).toBe("write release notes");
    }
  });

  it("sets a provisional title from the initial prompt immediately", () => {
    const { manager, sessionsState, titleGeneration } = createManager();
    mockTitleGeneration(titleGeneration);

    const sessionId = manager.createSession({
      cwd: "/tmp",
      sessionName: undefined,
      permissionMode: "default",
      modelReasoningEffort: "high",
      fastMode: "off",
      initialPrompt: "write release notes",
    });

    expect(sessionsState.state[sessionId]?.title).toBe("write release notes");
  });

  it("does not trigger title generation for named sessions", () => {
    const { manager, titleGeneration } = createManager();

    manager.createSession({
      cwd: "/tmp",
      sessionName: "Custom Session",
      permissionMode: "default",
      modelReasoningEffort: "high",
      fastMode: "off",
      initialPrompt: "write release notes",
    });

    expect(titleGeneration.requestFromPrompt).not.toHaveBeenCalled();
  });

  it("strips /plan prefix before title generation", () => {
    const { manager, titleGeneration } = createManager();

    const sessionId = manager.createSession({
      cwd: "/tmp",
      sessionName: undefined,
      permissionMode: "default",
      modelReasoningEffort: "high",
      fastMode: "off",
      initialPrompt: " /plan   draft implementation plan ",
    });

    expect(titleGeneration.requestFromPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        prompt: "draft implementation plan",
      }),
    );
  });

  it("skips title generation when /plan has no body", () => {
    const { manager, titleGeneration } = createManager();

    manager.createSession({
      cwd: "/tmp",
      sessionName: undefined,
      permissionMode: "default",
      modelReasoningEffort: "high",
      fastMode: "off",
      initialPrompt: "/plan   ",
    });

    expect(titleGeneration.requestFromPrompt).not.toHaveBeenCalled();
  });

  it("forgets title trigger state when deleting session", async () => {
    const { manager, titleGeneration } = createManager();

    const sessionId = manager.createSession({
      cwd: "/tmp",
      sessionName: undefined,
      permissionMode: "default",
      modelReasoningEffort: "high",
      fastMode: "off",
      initialPrompt: "Summarize open tasks",
    });

    await manager.deleteSession(sessionId);

    expect(titleGeneration.forget).toHaveBeenCalledWith(sessionId);
  });

  it("does not overwrite a manually renamed session when title generation resolves", () => {
    const { manager, sessionsState, titleGeneration } = createManager();
    let applyGeneratedTitle: (() => void) | undefined;

    vi.mocked(titleGeneration.requestFromPrompt).mockImplementation(
      (params) => {
        const provisional = deriveProvisionalTitleFromPrompt(params.prompt);
        if (provisional) {
          params.setTitle(provisional);
        }
        applyGeneratedTitle = () => {
          if (
            isAutoManagedSessionTitle(
              params.getTitle(),
              params.defaultTitle,
              params.prompt,
            )
          ) {
            params.setTitle("Generated title");
          }
        };
      },
    );

    const sessionId = manager.createSession({
      cwd: "/tmp",
      sessionName: undefined,
      permissionMode: "default",
      modelReasoningEffort: "high",
      fastMode: "off",
      initialPrompt: "Summarize open tasks",
    });

    manager.renameSession(sessionId, "Manually renamed");
    applyGeneratedTitle?.();

    expect(sessionsState.state[sessionId]?.title).toBe("Manually renamed");
    expect(titleGeneration.forget).toHaveBeenCalledWith(sessionId);
  });
});
