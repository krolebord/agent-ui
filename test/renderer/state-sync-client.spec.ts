import { enablePatches, type Patch } from "immer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

enablePatches();

type StateUpdateEvent = { version: number; patch: Patch[] };
type FullSnapshot<TState extends object> = {
  appVersion: string;
  version: number;
  state: TState;
};

const TEST_APP_VERSION = "test-app-version";

const locationReloadMock = vi.hoisted(() => vi.fn());

vi.stubGlobal("window", {
  location: { reload: locationReloadMock },
});

type BufferedStream = {
  bufferedEvents: StateUpdateEvent[];
  onEvent: ((event: StateUpdateEvent) => void) | null;
};

const orpcSpies = vi.hoisted(() => ({
  getFullStateSnapshot: vi.fn(),
  subscribeToStateUpdates: vi.fn(),
}));

const streamSpies = vi.hoisted(() => {
  const unsubscribe = vi.fn();

  return {
    createStream(): BufferedStream {
      return { bufferedEvents: [], onEvent: null };
    },
    consumeEventIterator: vi.fn((stream: BufferedStream, handlers) => {
      for (const event of stream.bufferedEvents) {
        handlers.onEvent(event);
      }
      stream.bufferedEvents = [];
      stream.onEvent = handlers.onEvent;
      return unsubscribe;
    }),
    emit(stream: BufferedStream, event: StateUpdateEvent) {
      if (stream.onEvent) {
        stream.onEvent(event);
        return;
      }
      stream.bufferedEvents.push(event);
    },
    unsubscribe,
  };
});

vi.mock("@renderer/orpc-client", () => ({
  orpc: {
    stateSync: {
      getFullStateSnapshot: { call: orpcSpies.getFullStateSnapshot },
      subscribeToStateUpdates: { call: orpcSpies.subscribeToStateUpdates },
    },
  },
}));

vi.mock("@orpc/client", () => ({
  consumeEventIterator: streamSpies.consumeEventIterator,
}));

import { setConnectionStatus } from "../../src/renderer/src/lib/connection-state";
import { createSyncStateStore } from "../../src/renderer/src/services/state-sync-client";

describe("createSyncStateStore", () => {
  const openStores: Array<() => void> = [];

  /** Stores keep a connection listener alive until unsubscribed. */
  async function createTrackedStore() {
    const result = await createSyncStateStore();
    openStores.push(result.unsubscribe);
    return result;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setConnectionStatus("connected");
  });

  afterEach(() => {
    for (const unsubscribe of openStores.splice(0)) {
      unsubscribe();
    }
  });

  it("skips buffered updates already covered by the bootstrap snapshot version", async () => {
    const stream = streamSpies.createStream();
    let resolveSnapshot:
      | ((value: FullSnapshot<{ items: string[] }>) => void)
      | null = null;
    const snapshotPromise = new Promise<FullSnapshot<{ items: string[] }>>(
      (resolve) => {
        resolveSnapshot = resolve;
      },
    );

    orpcSpies.subscribeToStateUpdates.mockResolvedValue(stream);
    orpcSpies.getFullStateSnapshot.mockReturnValue(snapshotPromise);

    const resultPromise = createSyncStateStore();

    expect(orpcSpies.subscribeToStateUpdates).toHaveBeenCalledTimes(1);
    expect(streamSpies.consumeEventIterator).not.toHaveBeenCalled();

    streamSpies.emit(stream, {
      version: 1,
      patch: [{ op: "add", path: ["items", 1], value: "draft" }],
    });

    if (!resolveSnapshot) {
      throw new Error("Expected snapshot resolver to be set");
    }
    const snapshotResolver = resolveSnapshot as (
      value: FullSnapshot<{ items: string[] }>,
    ) => void;
    snapshotResolver({
      appVersion: TEST_APP_VERSION,
      version: 1,
      state: { items: ["draft"] },
    });

    const { store, unsubscribe } = await resultPromise;

    expect(streamSpies.consumeEventIterator).toHaveBeenCalledWith(
      stream,
      expect.any(Object),
    );
    expect(store.getState()).toEqual({ items: ["draft"] });

    unsubscribe();
    expect(streamSpies.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("applies only the next update version", async () => {
    const stream = streamSpies.createStream();

    orpcSpies.subscribeToStateUpdates.mockResolvedValue(stream);
    orpcSpies.getFullStateSnapshot.mockResolvedValue({
      appVersion: TEST_APP_VERSION,
      version: 1,
      state: { count: 1 },
    });

    const { store } = await createTrackedStore();

    streamSpies.emit(stream, {
      version: 1,
      patch: [{ op: "replace", path: ["count"], value: 99 }],
    });
    streamSpies.emit(stream, {
      version: 3,
      patch: [{ op: "replace", path: ["count"], value: 3 }],
    });
    streamSpies.emit(stream, {
      version: 2,
      patch: [{ op: "replace", path: ["count"], value: 2 }],
    });

    await vi.waitFor(() => {
      expect(store.getState()).toEqual({ count: 2 });
    });
  });

  it("re-downloads snapshot when stream version has a gap", async () => {
    const stream = streamSpies.createStream();

    orpcSpies.subscribeToStateUpdates.mockResolvedValue(stream);
    orpcSpies.getFullStateSnapshot
      .mockResolvedValueOnce({
        appVersion: TEST_APP_VERSION,
        version: 1,
        state: { count: 1 },
      })
      .mockResolvedValueOnce({
        appVersion: TEST_APP_VERSION,
        version: 4,
        state: { count: 4 },
      });

    const { store } = await createTrackedStore();

    streamSpies.emit(stream, {
      version: 4,
      patch: [{ op: "replace", path: ["count"], value: 4 }],
    });

    await vi.waitFor(() => {
      expect(orpcSpies.getFullStateSnapshot).toHaveBeenCalledTimes(2);
      expect(store.getState()).toEqual({ count: 4 });
    });
  });

  it("re-subscribes and reloads the snapshot after a reconnect", async () => {
    const firstStream = streamSpies.createStream();
    const secondStream = streamSpies.createStream();

    orpcSpies.subscribeToStateUpdates
      .mockResolvedValueOnce(firstStream)
      .mockResolvedValueOnce(secondStream);
    orpcSpies.getFullStateSnapshot
      .mockResolvedValueOnce({
        appVersion: TEST_APP_VERSION,
        version: 1,
        state: { count: 1 },
      })
      .mockResolvedValueOnce({
        appVersion: TEST_APP_VERSION,
        version: 7,
        state: { count: 7 },
      });

    const { store } = await createTrackedStore();
    expect(store.getState()).toEqual({ count: 1 });

    setConnectionStatus("disconnected");
    setConnectionStatus("connected");

    await vi.waitFor(() => {
      expect(store.getState()).toEqual({ count: 7 });
    });
    expect(orpcSpies.subscribeToStateUpdates).toHaveBeenCalledTimes(2);
    // The dead stream is released when the fresh one takes over.
    expect(streamSpies.unsubscribe).toHaveBeenCalledTimes(1);

    // Updates from the stale stream must not corrupt the fresh snapshot.
    streamSpies.emit(firstStream, {
      version: 2,
      patch: [{ op: "replace", path: ["count"], value: 2 }],
    });
    streamSpies.emit(secondStream, {
      version: 8,
      patch: [{ op: "replace", path: ["count"], value: 8 }],
    });

    await vi.waitFor(() => {
      expect(store.getState()).toEqual({ count: 8 });
    });
  });

  it("applies updates that arrive after bootstrap", async () => {
    const stream = streamSpies.createStream();
    orpcSpies.subscribeToStateUpdates.mockResolvedValue(stream);
    orpcSpies.getFullStateSnapshot.mockResolvedValue({
      appVersion: TEST_APP_VERSION,
      version: 0,
      state: { count: 0 },
    });

    const { store } = await createTrackedStore();

    streamSpies.emit(stream, {
      version: 1,
      patch: [{ op: "replace", path: ["count"], value: 2 }],
    });

    await vi.waitFor(() => {
      expect(store.getState()).toEqual({ count: 2 });
    });
  });

  it("reloads the window when a later snapshot has a new appVersion", async () => {
    const firstStream = streamSpies.createStream();
    const secondStream = streamSpies.createStream();

    orpcSpies.subscribeToStateUpdates
      .mockResolvedValueOnce(firstStream)
      .mockResolvedValueOnce(secondStream);
    orpcSpies.getFullStateSnapshot
      .mockResolvedValueOnce({
        appVersion: "launch-1",
        version: 1,
        state: { count: 1 },
      })
      .mockResolvedValueOnce({
        appVersion: "launch-2",
        version: 1,
        state: { count: 99 },
      });

    await createTrackedStore();

    setConnectionStatus("disconnected");
    setConnectionStatus("connected");

    await vi.waitFor(() => {
      expect(locationReloadMock).toHaveBeenCalledTimes(1);
    });
  });
});
