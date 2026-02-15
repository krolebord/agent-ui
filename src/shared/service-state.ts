import {
  type Draft,
  type Patch,
  enablePatches,
  produceWithPatches,
} from "immer";
import {
  type TypedEventTarget,
  createTypedEventTarget,
} from "./typed-event-target";

const IS_DEV = process.env.NODE_ENV !== "production";

export type ServiceStateUpdateEvent<TState extends object> = {
  newState: TState;
  patch: Patch[];
};

function assertJsonSerializable(value: unknown, path: string): void {
  if (!IS_DEV || typeof value !== "object" || value === null) {
    return;
  }

  try {
    JSON.stringify(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`State at ${path} is not JSON-serializable: ${message}`);
  }
}

export interface ServiceState<K extends string, TState extends object> {
  key: K;
  get state(): Readonly<TState>;
  updateState: (updater: (state: Draft<TState>) => void) => void;
  eventTarget: TypedEventTarget<{
    "state-update": ServiceStateUpdateEvent<TState>;
  }>;
  "~snapshot": TState;
}

enablePatches();

export function defineServiceState<K extends string, TState extends object>({
  key,
  defaults,
}: {
  key: K;
  defaults: TState;
}): ServiceState<K, TState> {
  assertJsonSerializable(defaults, key);

  const eventTarget = createTypedEventTarget<{
    "state-update": ServiceStateUpdateEvent<TState>;
  }>();

  let state = structuredClone(defaults);

  return {
    key,
    eventTarget,
    get state() {
      return state;
    },
    updateState: (updater) => {
      const [next, patch] = produceWithPatches(state, updater);
      state = next;
      eventTarget.dispatchEvent("state-update", {
        newState: next,
        patch,
      });
    },
    get "~snapshot"(): TState {
      throw new Error("~snapshot should not be accessed directly");
    },
  };
}
