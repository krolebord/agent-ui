import { create } from "zustand";
import { combine } from "zustand/middleware";

// Controls the mobile sidebar drawer (Sheet). No-op state on desktop where
// the sidebar is always visible.
export const useMobileNavStore = create(
  combine(
    {
      sidebarOpen: false,
    },
    (set) => ({
      setSidebarOpen: (sidebarOpen: boolean) => set({ sidebarOpen }),
      openSidebar: () => set({ sidebarOpen: true }),
      closeSidebar: () => set({ sidebarOpen: false }),
    }),
  ),
);
