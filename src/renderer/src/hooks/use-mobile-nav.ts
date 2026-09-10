import { create } from "zustand";
import { combine } from "zustand/middleware";

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
