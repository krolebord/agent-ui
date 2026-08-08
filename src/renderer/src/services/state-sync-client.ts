import { consumeEventIterator } from "@orpc/client";
import {
  getConnectionState,
  subscribeToConnectionState,
} from "@renderer/lib/connection-state";
import { orpc } from "@renderer/orpc-client";
import { applyPatches, enablePatches } from "immer";
import { createStore } from "zustand";

enablePatches();

type SyncStateBootstrapSnapshot = Awaited<
  ReturnType<typeof orpc.stateSync.getFullStateSnapshot.call>
>;
type SyncStateSnapshot = SyncStateBootstrapSnapshot["state"];
type SyncStateUpdatesStream = Awaited<
  ReturnType<typeof orpc.stateSync.subscribeToStateUpdates.call>
>;
type SyncStateUpdateEvent = {
  version: number;
  patch: Parameters<typeof applyPatches>[1];
};

/**
 * Subscribes before snapshotting so no update slips through the gap between
 * the two calls; the version gate then drops whatever the snapshot covers.
 */
async function bootstrapStateStream() {
  const updatesStream = await orpc.stateSync.subscribeToStateUpdates.call();
  const snapshot = await orpc.stateSync.getFullStateSnapshot.call();
  return { updatesStream, snapshot };
}

export async function createSyncStateStore() {
  const bootstrap = await bootstrapStateStream();

  let currentVersion = bootstrap.snapshot.version;
  let streamGeneration = 0;
  let cancelStream: (() => void) | null = null;
  let updateQueue = Promise.resolve();

  const store = createStore<SyncStateSnapshot>(() => bootstrap.snapshot.state);

  const applySnapshot = (snapshot: SyncStateBootstrapSnapshot) => {
    currentVersion = snapshot.version;
    store.setState(snapshot.state, true);
  };

  const resyncState = async () => {
    applySnapshot(await orpc.stateSync.getFullStateSnapshot.call());
  };

  const handleUpdateEvent = (
    generation: number,
    event: SyncStateUpdateEvent,
  ) => {
    updateQueue = updateQueue
      .then(async () => {
        // Events from a stream we already replaced are stale by definition.
        if (generation !== streamGeneration) {
          return;
        }

        if (event.version <= currentVersion) {
          return;
        }

        if (event.version === currentVersion + 1) {
          try {
            store.setState(applyPatches(store.getState(), event.patch), true);
            currentVersion = event.version;
            return;
          } catch {
            // If patch application fails, local state drifted and we must re-bootstrap.
          }
        }

        await resyncState();
      })
      .catch((error) => {
        console.error("Failed to process state sync update event", error);
      });
  };

  const consumeStream = (
    generation: number,
    updatesStream: SyncStateUpdatesStream,
  ) => {
    cancelStream?.();
    cancelStream = consumeEventIterator(updatesStream, {
      onEvent(event) {
        handleUpdateEvent(generation, event);
      },
      onError(error) {
        if (generation !== streamGeneration) {
          return;
        }
        // The stream dies with the connection; reconnecting re-opens it.
        console.warn("State sync stream ended", error);
      },
    });
  };

  consumeStream(streamGeneration, bootstrap.updatesStream);

  /**
   * Re-opens the update stream and reloads the full snapshot so the store is
   * consistent with main again — the graceful equivalent of a page reload.
   */
  const reopenStateStream = async () => {
    const generation = ++streamGeneration;
    const { updatesStream, snapshot } = await bootstrapStateStream();
    if (generation !== streamGeneration) {
      return;
    }

    applySnapshot(snapshot);
    consumeStream(generation, updatesStream);
  };

  let lastConnectedEpoch = getConnectionState().epoch;
  const unsubscribeFromConnection = subscribeToConnectionState(() => {
    const { status, epoch } = getConnectionState();
    if (status !== "connected" || epoch === lastConnectedEpoch) {
      return;
    }

    lastConnectedEpoch = epoch;
    void reopenStateStream().catch((error) => {
      console.error("Failed to re-bootstrap state after reconnect", error);
    });
  });

  return {
    store,
    unsubscribe: () => {
      streamGeneration += 1;
      unsubscribeFromConnection();
      cancelStream?.();
      cancelStream = null;
    },
  };
}

export type SyncStateStore = Awaited<
  ReturnType<typeof createSyncStateStore>
>["store"];
