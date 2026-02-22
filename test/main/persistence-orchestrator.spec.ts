import { beforeEach, describe, expect, it, vi } from "vitest";
import z from "zod";
import {
  defineStatePersistence,
  PersistenceOrchestrator,
} from "../../src/main/persistence-orchestrator";
import { defineServiceState } from "../../src/shared/service-state";

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

describe("PersistenceOrchestrator", () => {
  beforeEach(() => {
    storeMock.reset();
  });

  it("hydrates persisted array state on registration", () => {
    const persistedProjects = [{ path: "/tmp/project", collapsed: false }];
    storeMock.seed({ projects: persistedProjects });

    const projectsState = defineServiceState({
      key: "projects" as const,
      defaults: [] as Array<{ path: string; collapsed: boolean }>,
    });

    const orchestrator = new PersistenceOrchestrator({ schemaVersion: 1 });
    orchestrator.registerAndHydrate(
      defineStatePersistence({
        serviceState: projectsState,
        schema: z.array(
          z.object({
            path: z.string(),
            collapsed: z.boolean(),
          }),
        ),
      }),
    );

    expect(projectsState.state).toEqual(persistedProjects);
  });

  it("shallow-merges persisted object state with defaults when keys are missing", () => {
    storeMock.seed({ appSettings: { timeoutMs: 1200 } });

    const appSettingsState = defineServiceState({
      key: "appSettings" as const,
      defaults: {
        timeoutMs: 500,
        telemetryEnabled: true,
      },
    });

    const orchestrator = new PersistenceOrchestrator({ schemaVersion: 1 });
    orchestrator.registerAndHydrate(
      defineStatePersistence({
        serviceState: appSettingsState,
        schema: z
          .object({
            timeoutMs: z.number(),
            telemetryEnabled: z.boolean(),
          })
          .partial(),
      }),
    );

    expect(appSettingsState.state).toEqual({
      timeoutMs: 1200,
      telemetryEnabled: true,
    });
  });
});
