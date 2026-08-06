import { beforeEach, describe, expect, it } from "vitest";
import {
  PersistenceOrchestrator,
  type PersistenceStore,
} from "../../src/main/persistence-orchestrator";
import {
  defineSessionServiceState,
  defineSessionStatePersistence,
} from "../../src/main/sessions/state";

const storeData = new Map<string, unknown>();
const storeMock: PersistenceStore = {
  get(key) {
    return storeData.get(key);
  },
  set(key, value) {
    storeData.set(key, structuredClone(value));
  },
};

function registerSessions() {
  const state = defineSessionServiceState();
  const orchestrator = new PersistenceOrchestrator({
    schemaVersion: 3,
    store: storeMock,
  });
  orchestrator.registerAndHydrate(defineSessionStatePersistence(state));
  return { state, orchestrator };
}

const claudeSession = {
  sessionId: "session-1",
  type: "claude-local-terminal" as const,
  title: "Session 1",
  createdAt: 1,
  lastActivityAt: 2,
  startupConfig: {
    cwd: "/tmp/project",
    permissionMode: "yolo" as const,
    model: "opus" as const,
    initialPrompt: "ship it",
  },
};

describe("session state persistence", () => {
  beforeEach(() => {
    storeData.clear();
  });

  it("omits runtime fields when persisting", () => {
    const { state, orchestrator } = registerSessions();

    state.updateState((sessions) => {
      sessions[claudeSession.sessionId] = {
        ...claudeSession,
        status: "running",
        warningMessage: "plugin missing",
        errorMessage: "process crashed",
      };
    });
    orchestrator.flushAll();

    const persisted = storeData.get("sessions") as Record<
      string,
      Record<string, unknown>
    >;
    const persistedSession = persisted[claudeSession.sessionId];
    expect(persistedSession).not.toHaveProperty("status");
    expect(persistedSession).not.toHaveProperty("warningMessage");
    expect(persistedSession).not.toHaveProperty("errorMessage");
    expect(persistedSession).toMatchObject({
      sessionId: claudeSession.sessionId,
      title: "Session 1",
    });
  });

  it("hydrates every session as stopped and drops a legacy persisted status", () => {
    storeData.set("sessions", {
      [claudeSession.sessionId]: {
        ...claudeSession,
        status: "running",
        errorMessage: "process crashed",
      },
    });

    const { state } = registerSessions();

    expect(state.state[claudeSession.sessionId]).toMatchObject({
      status: "stopped",
    });
    expect(state.state[claudeSession.sessionId]).not.toHaveProperty(
      "errorMessage",
    );
  });

  it("resolves an interrupted worktree setup and its running step to errors", () => {
    storeData.set("sessions", {
      "setup-1": {
        sessionId: "setup-1",
        type: "worktree-setup",
        title: "Setup",
        createdAt: 1,
        lastActivityAt: 2,
        status: "running",
        startupConfig: { cwd: "/tmp/worktree", projectRoot: "/tmp/project" },
        steps: [
          { command: "pnpm install", status: "success", output: "done" },
          { command: "pnpm build", status: "running", output: "building" },
          { command: "pnpm test", status: "pending", output: "" },
        ],
      },
    });

    const { state } = registerSessions();

    const session = state.state["setup-1"];
    expect(session).toMatchObject({ status: "error" });
    expect(session?.type === "worktree-setup" && session.steps).toMatchObject([
      { status: "success" },
      { status: "error", errorMessage: expect.stringContaining("interrupted") },
      { status: "pending" },
    ]);
  });
});
