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
