import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defineAppSettingsPersistence,
  defineAppSettingsState,
} from "../../src/main/app-settings";
import { PersistenceOrchestrator } from "../../src/main/persistence-orchestrator";
import { promptLibrarySchema } from "../../src/shared/prompt-library";

const storeMock = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  return {
    data,
    reset() {
      data.clear();
    },
    seed(values: Record<string, unknown>) {
      for (const [key, value] of Object.entries(values)) {
        data.set(key, structuredClone(value));
      }
    },
  };
});

vi.mock("electron-store", () => {
  class MockStore {
    constructor(options?: { defaults?: Record<string, unknown> }) {
      if (!options?.defaults) {
        return;
      }

      for (const [key, value] of Object.entries(options.defaults)) {
        if (!storeMock.data.has(key)) {
          storeMock.data.set(key, structuredClone(value));
        }
      }
    }

    get(key: string): unknown {
      return storeMock.data.get(key);
    }

    set(key: string, value: unknown): void {
      storeMock.data.set(key, structuredClone(value));
    }
  }

  return { default: MockStore };
});

describe("app settings prompt library", () => {
  beforeEach(() => {
    storeMock.reset();
  });

  it("defaults to an empty prompt library", () => {
    const state = defineAppSettingsState();
    expect(state.state.promptLibrary).toEqual([]);
  });

  it("defaults sleep blocking to working mode", () => {
    const state = defineAppSettingsState();
    expect(state.state.sleepBlockMode).toBe("working");
  });

  it("defaults machine stats to enabled with compact polling intervals", () => {
    const state = defineAppSettingsState();
    expect(state.state.machineStats).toEqual({
      enabled: true,
      cpuMemoryPollIntervalSeconds: 15,
      temperaturePollIntervalSeconds: 30,
    });
  });

  it("hydrates persisted machine stats settings", () => {
    storeMock.seed({
      appSettings: {
        machineStats: {
          enabled: false,
          cpuMemoryPollIntervalSeconds: 60,
          temperaturePollIntervalSeconds: 300,
        },
      },
    });

    const state = defineAppSettingsState();
    const orchestrator = new PersistenceOrchestrator({ schemaVersion: 3 });
    orchestrator.registerAndHydrate(defineAppSettingsPersistence(state));

    expect(state.state.machineStats).toEqual({
      enabled: false,
      cpuMemoryPollIntervalSeconds: 60,
      temperaturePollIntervalSeconds: 300,
    });
  });

  it("falls back for invalid persisted machine stats intervals", () => {
    storeMock.seed({
      appSettings: {
        machineStats: {
          enabled: false,
          cpuMemoryPollIntervalSeconds: 1,
          temperaturePollIntervalSeconds: 10_000,
        },
      },
    });

    const state = defineAppSettingsState();
    const orchestrator = new PersistenceOrchestrator({ schemaVersion: 3 });
    orchestrator.registerAndHydrate(defineAppSettingsPersistence(state));

    expect(state.state.machineStats).toEqual({
      enabled: false,
      cpuMemoryPollIntervalSeconds: 15,
      temperaturePollIntervalSeconds: 30,
    });
  });

  it("hydrates persisted sleep block mode", () => {
    storeMock.seed({
      appSettings: {
        sleepBlockMode: "always",
      },
    });

    const state = defineAppSettingsState();
    const orchestrator = new PersistenceOrchestrator({ schemaVersion: 3 });
    orchestrator.registerAndHydrate(defineAppSettingsPersistence(state));

    expect(state.state.sleepBlockMode).toBe("always");
  });

  it("migrates legacy enabled prevent sleep setting to working mode", () => {
    storeMock.seed({
      appSettings: {
        preventSleep: true,
      },
    });

    const state = defineAppSettingsState();
    const orchestrator = new PersistenceOrchestrator({ schemaVersion: 3 });
    orchestrator.registerAndHydrate(defineAppSettingsPersistence(state));

    expect(state.state.sleepBlockMode).toBe("working");
  });

  it("migrates legacy disabled prevent sleep setting to off mode", () => {
    storeMock.seed({
      appSettings: {
        preventSleep: false,
      },
    });

    const state = defineAppSettingsState();
    const orchestrator = new PersistenceOrchestrator({ schemaVersion: 3 });
    orchestrator.registerAndHydrate(defineAppSettingsPersistence(state));

    expect(state.state.sleepBlockMode).toBe("off");
  });

  it("rejects invalid prompt library entries during hydration", () => {
    storeMock.seed({
      appSettings: {
        promptLibrary: [
          { id: "bad", name: "", body: "", createdAt: 0, updatedAt: 0 },
        ],
      },
    });

    const state = defineAppSettingsState();
    const orchestrator = new PersistenceOrchestrator({ schemaVersion: 3 });
    orchestrator.registerAndHydrate(defineAppSettingsPersistence(state));

    expect(state.state.promptLibrary).toEqual([]);
  });

  it("persists valid prompt library entries", () => {
    const now = 1_700_000_000_000;
    storeMock.seed({
      appSettings: {
        promptLibrary: [
          {
            id: "prompt-1",
            name: "Review diff",
            body: "Review the current diff for bugs.",
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    });

    const state = defineAppSettingsState();
    const orchestrator = new PersistenceOrchestrator({ schemaVersion: 3 });
    orchestrator.registerAndHydrate(defineAppSettingsPersistence(state));

    expect(state.state.promptLibrary).toEqual([
      {
        id: "prompt-1",
        name: "Review diff",
        body: "Review the current diff for bugs.",
        createdAt: now,
        updatedAt: now,
      },
    ]);
  });

  it("parses prompt library arrays with fallback", () => {
    expect(promptLibrarySchema.parse(undefined)).toEqual([]);
    expect(promptLibrarySchema.parse("invalid")).toEqual([]);
  });
});
