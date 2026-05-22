import { describe, expect, it, vi } from "vitest";
import {
  type ClaudeLocalTerminalSessionData,
  SessionsServiceNew,
} from "../../src/main/session-service";
import type { SessionStateFileManager } from "../../src/main/session-state-file-manager";
import type { SessionServiceState } from "../../src/main/sessions/state";
import type { TitleGenerationService } from "../../src/main/title-generation-service";

function createService() {
  const state: Record<string, ClaudeLocalTerminalSessionData> = {};
  const sessionsState = {
    state,
    updateState: (updater: (draft: typeof state) => void) => {
      updater(state);
    },
  } as unknown as SessionServiceState;

  const titleGeneration = {
    requestFromPrompt: vi.fn(),
    forget: vi.fn(),
  } as unknown as TitleGenerationService;

  const stateFileManager = {
    create: vi.fn().mockResolvedValue("/tmp/test-state.ndjson"),
    cleanup: vi.fn(),
  } as unknown as SessionStateFileManager;

  const service = new SessionsServiceNew({
    pluginDir: null,
    pluginWarning: null,
    titleGeneration,
    stateFileManager,
    state: sessionsState,
  });

  return { service, state, titleGeneration };
}

describe("SessionsServiceNew.renameSession", () => {
  it("updates the Claude session title", () => {
    const { service, state, titleGeneration } = createService();

    state["session-1"] = {
      sessionId: "session-1",
      type: "claude-local-terminal",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "stopped",
      title: "Old Name",
      startupConfig: {
        cwd: "/tmp",
        permissionMode: "default",
        model: "opus",
        initialPrompt: undefined,
      },
      bufferedOutput: "",
    };

    service.renameSession("session-1", "  New Name  ");

    expect(state["session-1"]?.title).toBe("New Name");
    expect(vi.mocked(titleGeneration.forget)).toHaveBeenCalledWith("session-1");
  });
});
