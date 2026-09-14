import type { SyncStateStore } from "@renderer/services/state-sync-client";
import { createContext, useContext } from "react";
import { type ExtractState, useStore } from "zustand";

const stateContext = createContext<SyncStateStore | null>(null);

export function SyncStateProvider({
  children,
  store,
}: {
  children: React.ReactNode;
  store: SyncStateStore;
}) {
  return (
    <stateContext.Provider value={store}>{children}</stateContext.Provider>
  );
}

export function useAppStateStore(): SyncStateStore {
  const store = useContext(stateContext);
  if (!store) {
    throw new Error("useAppStateStore must be used within a SyncStateProvider");
  }
  return store;
}

export function useAppState<T>(
  selector: (state: ExtractState<SyncStateStore>) => T,
) {
  return useStore(useAppStateStore(), selector);
}
