import { describe, expect, it, vi } from "vitest";
import { createInMemorySessionBufferStore } from "../../src/main/database/session-buffer-store";
import {
  PersistenceOrchestrator,
  type PersistenceStore,
} from "../../src/main/persistence-orchestrator";
import { migrateSessionInitialPrompts } from "../../src/main/sessions/initial-prompt-migration";
import {
  defineSessionServiceState,
  defineSessionStatePersistence,
} from "../../src/main/sessions/state";

function createFixture() {
  const legacy = {
    claude: {
      sessionId: "claude",
      type: "claude-local-terminal",
      title: "Claude",
      createdAt: 1,
      lastActivityAt: 2,
      startupConfig: {
        cwd: "/project",
        permissionMode: "default",
        model: "opus",
        initialPrompt: "Claude prompt\nwith a second line",
      },
    },
    codex: {
      sessionId: "codex",
      type: "codex-local-terminal",
      title: "Codex",
      createdAt: 1,
      lastActivityAt: 2,
      startupConfig: {
        cwd: "/project",
        initialPrompt: "/plan Codex prompt",
      },
      codexSessionId: "thread-1",
    },
    cursor: {
      sessionId: "cursor",
      type: "cursor-agent",
      title: "Cursor",
      createdAt: 1,
      lastActivityAt: 2,
      startupConfig: { cwd: "/project", initialPrompt: "Cursor prompt 🐈" },
      initialPromptSent: true,
    },
    terminal: {
      sessionId: "terminal",
      type: "local-terminal",
      title: "Terminal",
      createdAt: 1,
      lastActivityAt: 2,
      startupConfig: { cwd: "/project" },
    },
  };
  const data = new Map<string, unknown>([
    ["sessions", structuredClone(legacy)],
  ]);
  const store: PersistenceStore = {
    get: (key) => data.get(key),
    set: (key, value) => data.set(key, structuredClone(value)),
  };
  const sessionBuffers = createInMemorySessionBufferStore();
  return { legacy, store, sessionBuffers };
}

describe("initial prompt migration", () => {
  it("moves prompts for every agent type and hydrates state without their text", async () => {
    const { legacy, store, sessionBuffers } = createFixture();
    await sessionBuffers.set("claude", "existing output");
    await expect(
      migrateSessionInitialPrompts({ store, sessionBuffers }),
    ).resolves.toBe(3);
    await expect(sessionBuffers.get("claude")).resolves.toBe("existing output");
    for (const key of ["claude", "codex", "cursor"] as const) {
      await expect(sessionBuffers.getInitialPrompt(key)).resolves.toBe(
        legacy[key].startupConfig.initialPrompt,
      );
    }

    const state = defineSessionServiceState();
    const persistence = new PersistenceOrchestrator({
      schemaVersion: 3,
      store,
    });
    persistence.registerAndHydrate(defineSessionStatePersistence(state));
    for (const key of ["claude", "codex", "cursor"]) {
      expect(state.state[key]).toMatchObject({
        hasInitialPrompt: true,
        status: "stopped",
      });
      expect(state.state[key]?.startupConfig).not.toHaveProperty(
        "initialPrompt",
      );
    }
    expect(state.state.cursor).toMatchObject({ initialPromptSent: true });
    expect(state.state.codex).toMatchObject({ codexSessionId: "thread-1" });
    expect(state.state.terminal).not.toHaveProperty("hasInitialPrompt");

    state.updateState((sessions) => {
      if (sessions.claude) sessions.claude.title = "Renamed";
    });
    persistence.dispose();
    expect(JSON.stringify(store.get("sessions"))).not.toContain(
      '"initialPrompt":',
    );
    await expect(
      migrateSessionInitialPrompts({ store, sessionBuffers }),
    ).resolves.toBe(0);
    await expect(sessionBuffers.getInitialPrompt("claude")).resolves.toBe(
      legacy.claude.startupConfig.initialPrompt,
    );
  });

  it("retains all JSON prompts after a partial SQLite failure and succeeds on retry", async () => {
    const { legacy, store, sessionBuffers } = createFixture();
    const write = sessionBuffers.setInitialPrompt;
    const fail = vi
      .spyOn(sessionBuffers, "setInitialPrompt")
      .mockImplementationOnce(write)
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(
      migrateSessionInitialPrompts({ store, sessionBuffers }),
    ).rejects.toThrow("disk full");
    expect(store.get("sessions")).toEqual(legacy);
    fail.mockRestore();
    await expect(
      migrateSessionInitialPrompts({ store, sessionBuffers }),
    ).resolves.toBe(3);
    await expect(
      migrateSessionInitialPrompts({ store, sessionBuffers }),
    ).resolves.toBe(0);
  });

  it("retains JSON if its rewrite fails after SQLite writes", async () => {
    const { legacy, store, sessionBuffers } = createFixture();
    const fail = vi.spyOn(store, "set").mockImplementationOnce(() => {
      throw new Error("JSON write failed");
    });
    await expect(
      migrateSessionInitialPrompts({ store, sessionBuffers }),
    ).rejects.toThrow("JSON write failed");
    expect(store.get("sessions")).toEqual(legacy);
    await expect(sessionBuffers.getInitialPrompt("cursor")).resolves.toBe(
      legacy.cursor.startupConfig.initialPrompt,
    );
    fail.mockRestore();
    await expect(
      migrateSessionInitialPrompts({ store, sessionBuffers }),
    ).resolves.toBe(3);
  });

  it("preserves unrelated fields and does not rewrite sessions without prompts", async () => {
    const { store, sessionBuffers } = createFixture();
    store.set("sessions", {
      existing: {
        startupConfig: { cwd: "/project" },
        hasInitialPrompt: true,
        extra: { value: 1 },
      },
      blank: {
        startupConfig: { cwd: "/project", initialPrompt: "  " },
        extra: { value: 2 },
      },
    });
    await migrateSessionInitialPrompts({ store, sessionBuffers });
    expect(store.get("sessions")).toEqual({
      existing: {
        startupConfig: { cwd: "/project" },
        hasInitialPrompt: true,
        extra: { value: 1 },
      },
      blank: {
        startupConfig: { cwd: "/project" },
        hasInitialPrompt: false,
        extra: { value: 2 },
      },
    });
    await expect(sessionBuffers.getInitialPrompt("blank")).resolves.toBe(
      undefined,
    );
    await expect(sessionBuffers.get("blank")).resolves.toBe(undefined);
    const write = vi.spyOn(store, "set");
    await migrateSessionInitialPrompts({ store, sessionBuffers });
    expect(write).not.toHaveBeenCalled();
  });

  it("leaves invalid persisted data for the normal hydration error handling", async () => {
    const { store, sessionBuffers } = createFixture();
    const invalid = { invalid: { startupConfig: { initialPrompt: 123 } } };
    store.set("sessions", invalid);
    await expect(
      migrateSessionInitialPrompts({ store, sessionBuffers }),
    ).resolves.toBe(0);
    expect(store.get("sessions")).toEqual(invalid);
  });

  it("migrates valid prompts even when another session is malformed", async () => {
    const { legacy, store, sessionBuffers } = createFixture();
    const invalid = { startupConfig: { initialPrompt: 123 } };
    store.set("sessions", { ...legacy, invalid });
    await expect(
      migrateSessionInitialPrompts({ store, sessionBuffers }),
    ).resolves.toBe(3);
    expect(store.get("sessions")).toMatchObject({ invalid });
    await expect(sessionBuffers.getInitialPrompt("claude")).resolves.toBe(
      legacy.claude.startupConfig.initialPrompt,
    );
  });
});
