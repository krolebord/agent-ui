import { consumeEventIterator } from "@orpc/client";
import { orpc } from "@renderer/orpc-client";
import { applyPatches, enablePatches } from "immer";
import { createStore } from "zustand";

enablePatches();

type SyncStateBootstrapSnapshot = Awaited<
  ReturnType<typeof orpc.stateSync.getFullStateSnapshot.call>
>;
type SyncStateSnapshot = SyncStateBootstrapSnapshot["state"];

export async function createSyncStateStore() {
  const updatesStream = await orpc.stateSync.subscribeToStateUpdates.call();
  const initialSnapshot = await orpc.stateSync.getFullStateSnapshot.call();
  let currentVersion = initialSnapshot.version;

  const store = createStore<SyncStateSnapshot>(() => initialSnapshot.state);

  const resyncState = async () => {
    const latestSnapshot = await orpc.stateSync.getFullStateSnapshot.call();
    currentVersion = latestSnapshot.version;
    store.setState(latestSnapshot.state, true);
  };

  let updateQueue = Promise.resolve();

  const unsubscribe = consumeEventIterator(updatesStream, {
    onEvent(event) {
      updateQueue = updateQueue
        .then(async () => {
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
    },
  });

  return {
    store,
    unsubscribe,
  };
}

export type SyncStateStore = Awaited<
  ReturnType<typeof createSyncStateStore>
>["store"];
