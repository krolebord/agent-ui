import {
  type ConnectionState,
  getConnectionState,
  subscribeToConnectionState,
} from "@renderer/lib/connection-state";
import { useSyncExternalStore } from "react";

export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(
    subscribeToConnectionState,
    getConnectionState,
    getConnectionState,
  );
}
