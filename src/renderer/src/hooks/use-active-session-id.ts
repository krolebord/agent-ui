import { orpc } from "@renderer/orpc-client";
import { create } from "zustand";
import { combine, persist } from "zustand/middleware";

export function useActiveSessionId() {
  return useActiveSessionStore((state) => state.activeSessionId);
}

const STORAGE_KEY = "agent-ui:activeSessionId";

export function switchSession(nextSessionId: string | null): void {
  const prevSessionId = useActiveSessionStore.getState().activeSessionId;
  useActiveSessionStore.getState().setActiveSessionId(nextSessionId);
  if (nextSessionId) {
    if (prevSessionId && prevSessionId !== nextSessionId) {
      void orpc.sessions.markSeen.call({ sessionId: prevSessionId });
    }
    void orpc.sessions.markSeen.call({ sessionId: nextSessionId });
  }
}

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
