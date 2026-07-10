import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import z from "zod";
import {
  createPersistenceStore,
  defineStatePersistence,
  PersistenceOrchestrator,
  type PersistenceStore,
} from "../../src/main/persistence-orchestrator";
import { defineServiceState } from "../../src/shared/service-state";

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

describe("PersistenceOrchestrator", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    storeData.clear();
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("hydrates persisted array state on registration", () => {
    const persistedProjects = [{ path: "/tmp/project", collapsed: false }];
    seedStore({ projects: persistedProjects });

    const projectsState = defineServiceState({
      key: "projects" as const,
      defaults: [] as Array<{ path: string; collapsed: boolean }>,
    });

    const orchestrator = new PersistenceOrchestrator({
      schemaVersion: 1,
      store: storeMock,
    });
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
    seedStore({ appSettings: { timeoutMs: 1200 } });

    const appSettingsState = defineServiceState({
      key: "appSettings" as const,
      defaults: {
        timeoutMs: 500,
        telemetryEnabled: true,
      },
    });

    const orchestrator = new PersistenceOrchestrator({
      schemaVersion: 1,
      store: storeMock,
    });
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

  it("reads and writes the existing agent-ui.json format with Conf", async () => {
    const userDataPath = await mkdtemp(
      path.join(os.tmpdir(), "agent-ui-persistence-"),
    );
    tempDirs.push(userDataPath);
    await writeFile(
      path.join(userDataPath, "agent-ui.json"),
      JSON.stringify({ projects: [{ path: "/existing" }] }),
    );

    const projectsState = defineServiceState({
      key: "projects" as const,
      defaults: [] as Array<{ path: string }>,
    });
    const orchestrator = new PersistenceOrchestrator({
      schemaVersion: 3,
      store: createPersistenceStore(userDataPath),
    });
    orchestrator.registerAndHydrate(
      defineStatePersistence({
        serviceState: projectsState,
        schema: z.array(z.object({ path: z.string() })),
        debounceMs: 0,
      }),
    );

    expect(projectsState.state).toEqual([{ path: "/existing" }]);

    projectsState.updateState((projects) => {
      projects.push({ path: "/new" });
    });
    orchestrator.dispose();

    const persisted = JSON.parse(
      await readFile(path.join(userDataPath, "agent-ui.json"), "utf8"),
    );
    expect(persisted).toMatchObject({
      schemaVersion: 3,
      projects: [{ path: "/existing" }, { path: "/new" }],
    });
  });
});
