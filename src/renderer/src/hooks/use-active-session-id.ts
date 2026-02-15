import { create } from "zustand";
import { combine, persist } from "zustand/middleware";

export function useActiveSessionId() {
  return useActiveSessionStore((state) => state.activeSessionId);
}

const STORAGE_KEY = "claude-ui:activeSessionId";

export const useActiveSessionStore = create(
  persist(
    combine(
      {
        activeSessionId: null as string | null,
      },
      (set) => ({
        setActiveSessionId: (activeSessionId: string | null) => {
          set({ activeSessionId });
        },
      }),
    ),
    {
      name: STORAGE_KEY,
    },
  ),
);
