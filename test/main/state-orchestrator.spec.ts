import { describe, expect, it } from "vitest";
import { StateOrchestrator } from "../../src/main/state-orchestrator";
import { defineServiceState } from "../../src/shared/service-state";

describe("StateOrchestrator", () => {
  it("buffers all queued state updates for async iterator subscribers", async () => {
    const projectsState = defineServiceState({
      key: "projects",
      defaults: { count: 0 },
    });

    const orchestrator = new StateOrchestrator({
      serviceStates: {
        projects: projectsState,
      },
    });

    const iterator = orchestrator.eventPublisher.subscribe("state-update");

    projectsState.updateState((draft) => {
      draft.count = 1;
    });
    projectsState.updateState((draft) => {
      draft.count = 2;
    });

    const first = await iterator.next();
    const second = await iterator.next();

    expect(orchestrator.getAllStatesSnapshot()).toEqual({
      version: 2,
      state: {
        projects: { count: 2 },
      },
    });

    expect(first).toEqual({
      done: false,
      value: {
        version: 1,
        patch: [{ op: "replace", path: ["projects", "count"], value: 1 }],
      },
    });
    expect(second).toEqual({
      done: false,
      value: {
        version: 2,
        patch: [{ op: "replace", path: ["projects", "count"], value: 2 }],
      },
    });

    await iterator.return(undefined);
    orchestrator.dispose();
  });
});
