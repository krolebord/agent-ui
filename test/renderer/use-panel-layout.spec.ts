import { beforeEach, describe, expect, it } from "vitest";
import {
  savePanelLayout,
  usePanelLayoutStore,
} from "../../src/renderer/src/hooks/use-panel-layout";

const initialState = usePanelLayoutStore.getState();

describe("savePanelLayout", () => {
  beforeEach(() => {
    usePanelLayoutStore.setState(initialState, true);
  });

  it("stores known panel sizes as percentages", () => {
    savePanelLayout(
      { _r_1_: 75.5, projectPaneSidebar: 24.5 },
      { isUserInteraction: true },
    );

    const state = usePanelLayoutStore.getState();
    expect(state.projectPaneSidebar).toBe("24.5%");
    expect(state).not.toHaveProperty("_r_1_");
  });

  it("ignores layout changes the user did not make", () => {
    savePanelLayout(
      { _r_1_: 70, sessionSidePane: 30 },
      { isUserInteraction: false },
    );

    expect(usePanelLayoutStore.getState().sessionSidePane).toBe(
      initialState.sessionSidePane,
    );
  });
});
