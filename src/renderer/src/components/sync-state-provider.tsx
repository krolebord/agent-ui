import { SyncStateStore } from "@renderer/services/state-sync-client";
import { createContext, useContext } from "react";
import { useStore, ExtractState } from "zustand";

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

export function useAppState<T>(
  selector: (state: ExtractState<SyncStateStore>) => T,
) {
  const store = useContext(stateContext);
  if (!store) {
    throw new Error("useAppState must be used within a SyncStateProvider");
  }
  return useStore(store, selector);
}
