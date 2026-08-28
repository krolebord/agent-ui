import { beforeEach, describe, expect, it } from "vitest";
import {
  PersistenceOrchestrator,
  type PersistenceStore,
} from "../../src/main/persistence-orchestrator";
import {
  defineProjectTerminalsPersistence,
  defineProjectTerminalsState,
} from "../../src/main/project-terminals";

const storeData = new Map<string, unknown>();
const storeMock: PersistenceStore = {
  get(key) {
    return storeData.get(key);
  },
  set(key, value) {
    storeData.set(key, structuredClone(value));
  },
};

function registerProjectTerminals() {
  const state = defineProjectTerminalsState();
  const orchestrator = new PersistenceOrchestrator({
    schemaVersion: 3,
    store: storeMock,
  });
  orchestrator.registerAndHydrate(defineProjectTerminalsPersistence(state));
  return { state, orchestrator };
}

const workspaceCwd = "/tmp/project";
const terminalId = "terminal-1";

const persistedTerminal = {
  terminalId,
  title: "dev",
  cwd: workspaceCwd,
  createdAt: 1,
  commandId: "script:dev",
};

const persistedWorkspace = {
  cwd: workspaceCwd,
  selectedTerminalId: terminalId,
  nextTerminalOrdinal: 2,
  order: [terminalId],
  terminals: { [terminalId]: persistedTerminal },
};

describe("project terminals persistence", () => {
  beforeEach(() => {
    storeData.clear();
  });

  it("omits runtime fields when persisting", () => {
    const { state, orchestrator } = registerProjectTerminals();

    state.updateState((workspaces) => {
      workspaces[workspaceCwd] = {
        ...persistedWorkspace,
        terminals: {
          [terminalId]: {
            ...persistedTerminal,
            status: "running",
            errorMessage: "spawn failed",
          },
        },
      };
    });
    orchestrator.flushAll();

    const persisted = storeData.get("projectTerminals") as Record<
      string,
      { terminals: Record<string, Record<string, unknown>> }
    >;
    const terminal = persisted[workspaceCwd]?.terminals[terminalId];
    expect(terminal).not.toHaveProperty("status");
    expect(terminal).not.toHaveProperty("errorMessage");
    expect(terminal).toMatchObject({ terminalId, title: "dev" });
  });

  it("hydrates terminals as stopped and drops a legacy persisted status", () => {
    storeData.set("projectTerminals", {
      [workspaceCwd]: {
        ...persistedWorkspace,
        terminals: {
          [terminalId]: {
            ...persistedTerminal,
            status: "running",
            errorMessage: "spawn failed",
          },
        },
      },
    });

    const { state } = registerProjectTerminals();

    const terminal = state.state[workspaceCwd]?.terminals[terminalId];
    expect(terminal).toMatchObject({ status: "stopped" });
    expect(terminal).not.toHaveProperty("errorMessage");
    expect(state.state[workspaceCwd]).toMatchObject({
      selectedTerminalId: terminalId,
      nextTerminalOrdinal: 2,
      order: [terminalId],
    });
  });
});
