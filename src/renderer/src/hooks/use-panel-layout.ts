import type { Layout, LayoutChangedMeta } from "react-resizable-panels";
import { create } from "zustand";
import { persist } from "zustand/middleware";

const defaultPanelSizes = {
  sessionsSidebar: "18%",
  sessionSidePane: "20%",
  projectBottomPane: "30%",
  projectPaneSidebar: "20%",
  historyCommits: "20%",
};

export type PanelSizeId = keyof typeof defaultPanelSizes;

export const usePanelLayoutStore = create<Record<PanelSizeId, string>>()(
  persist(() => defaultPanelSizes, { name: "agent-ui:panelLayout" }),
);

function isPanelSizeId(id: string): id is PanelSizeId {
  return Object.hasOwn(defaultPanelSizes, id);
}

export function usePanelSize(id: PanelSizeId): string {
  return usePanelLayoutStore((state) => state[id]);
}

export function savePanelLayout(
  layout: Layout,
  { isUserInteraction }: LayoutChangedMeta,
) {
  if (!isUserInteraction) return;

  const sizes: Partial<Record<PanelSizeId, string>> = {};
  for (const [id, size] of Object.entries(layout)) {
    if (isPanelSizeId(id)) sizes[id] = `${size}%`;
  }
  usePanelLayoutStore.setState(sizes);
}
