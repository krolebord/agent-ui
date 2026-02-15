import { enablePatches, type Patch } from "immer";
import { beforeEach, describe, expect, it, vi } from "vitest";

enablePatches();

type StateUpdateEvent = { version: number; patch: Patch[] };
type FullSnapshot<TState extends object> = {
  version: number;
  state: TState;
};
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

import { createSyncStateStore } from "../../src/renderer/src/services/state-sync-client";

describe("createSyncStateStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    resolveSnapshot?.({
      version: 1,
      state: { items: ["draft"] },
    });

    const { store, unsubscribe } = await resultPromise;

    expect(streamSpies.consumeEventIterator).toHaveBeenCalledWith(
      stream,
      expect.any(Object),
    );
    expect(store.getState()).toEqual({ items: ["draft"] });
    expect(unsubscribe).toBe(streamSpies.unsubscribe);
  });

  it("applies only the next update version", async () => {
    const stream = streamSpies.createStream();

    orpcSpies.subscribeToStateUpdates.mockResolvedValue(stream);
    orpcSpies.getFullStateSnapshot.mockResolvedValue({
      version: 1,
      state: { count: 1 },
    });

    const { store } = await createSyncStateStore();

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
        version: 1,
        state: { count: 1 },
      })
      .mockResolvedValueOnce({
        version: 4,
        state: { count: 4 },
      });

    const { store } = await createSyncStateStore();

    streamSpies.emit(stream, {
      version: 4,
      patch: [{ op: "replace", path: ["count"], value: 4 }],
    });

    await vi.waitFor(() => {
      expect(orpcSpies.getFullStateSnapshot).toHaveBeenCalledTimes(2);
      expect(store.getState()).toEqual({ count: 4 });
    });
  });

  it("applies updates that arrive after bootstrap", async () => {
    const stream = streamSpies.createStream();
    orpcSpies.subscribeToStateUpdates.mockResolvedValue(stream);
    orpcSpies.getFullStateSnapshot.mockResolvedValue({
      version: 0,
      state: { count: 0 },
    });

    const { store } = await createSyncStateStore();

    streamSpies.emit(stream, {
      version: 1,
      patch: [{ op: "replace", path: ["count"], value: 2 }],
    });

    await vi.waitFor(() => {
      expect(store.getState()).toEqual({ count: 2 });
    });
  });
});
