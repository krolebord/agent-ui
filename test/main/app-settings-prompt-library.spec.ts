import { beforeEach, describe, expect, it } from "vitest";
import {
  defineAppSettingsPersistence,
  defineAppSettingsState,
} from "../../src/main/app-settings";
import {
  PersistenceOrchestrator,
  type PersistenceStore,
} from "../../src/main/persistence-orchestrator";
import { promptLibrarySchema } from "../../src/shared/prompt-library";

const storeData = new Map<string, unknown>();
const storeMock: PersistenceStore = {
  get(key) {
    return storeData.get(key);
  },
  set(key, value) {
    storeData.set(key, structuredClone(value));
  },
};

function seedStore(values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) {
    storeData.set(key, structuredClone(value));
  }
}

function createOrchestrator() {
  return new PersistenceOrchestrator({ schemaVersion: 3, store: storeMock });
}

describe("app settings prompt library", () => {
  beforeEach(() => {
    storeData.clear();
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
    seedStore({
      appSettings: {
        machineStats: {
          enabled: false,
          cpuMemoryPollIntervalSeconds: 60,
          temperaturePollIntervalSeconds: 300,
        },
      },
    });

    const state = defineAppSettingsState();
    const orchestrator = createOrchestrator();
    orchestrator.registerAndHydrate(defineAppSettingsPersistence(state));

    expect(state.state.machineStats).toEqual({
      enabled: false,
      cpuMemoryPollIntervalSeconds: 60,
      temperaturePollIntervalSeconds: 300,
    });
  });

  it("falls back for invalid persisted machine stats intervals", () => {
    seedStore({
      appSettings: {
        machineStats: {
          enabled: false,
          cpuMemoryPollIntervalSeconds: 1,
          temperaturePollIntervalSeconds: 10_000,
        },
      },
    });

    const state = defineAppSettingsState();
    const orchestrator = createOrchestrator();
    orchestrator.registerAndHydrate(defineAppSettingsPersistence(state));

    expect(state.state.machineStats).toEqual({
      enabled: false,
      cpuMemoryPollIntervalSeconds: 15,
      temperaturePollIntervalSeconds: 30,
    });
  });

  it("hydrates persisted sleep block mode", () => {
    seedStore({
      appSettings: {
        sleepBlockMode: "always",
      },
    });

    const state = defineAppSettingsState();
    const orchestrator = createOrchestrator();
    orchestrator.registerAndHydrate(defineAppSettingsPersistence(state));

    expect(state.state.sleepBlockMode).toBe("always");
  });

  it("migrates legacy enabled prevent sleep setting to working mode", () => {
    seedStore({
      appSettings: {
        preventSleep: true,
      },
    });

    const state = defineAppSettingsState();
    const orchestrator = createOrchestrator();
    orchestrator.registerAndHydrate(defineAppSettingsPersistence(state));

    expect(state.state.sleepBlockMode).toBe("working");
  });

  it("migrates legacy disabled prevent sleep setting to off mode", () => {
    seedStore({
      appSettings: {
        preventSleep: false,
      },
    });

    const state = defineAppSettingsState();
    const orchestrator = createOrchestrator();
    orchestrator.registerAndHydrate(defineAppSettingsPersistence(state));

    expect(state.state.sleepBlockMode).toBe("off");
  });

  it("rejects invalid prompt library entries during hydration", () => {
    seedStore({
      appSettings: {
        promptLibrary: [
          { id: "bad", name: "", body: "", createdAt: 0, updatedAt: 0 },
        ],
      },
    });

    const state = defineAppSettingsState();
    const orchestrator = createOrchestrator();
    orchestrator.registerAndHydrate(defineAppSettingsPersistence(state));

    expect(state.state.promptLibrary).toEqual([]);
  });

  it("persists valid prompt library entries", () => {
    const now = 1_700_000_000_000;
    seedStore({
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
    const orchestrator = createOrchestrator();
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
