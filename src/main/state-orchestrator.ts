import { EventPublisher } from "@orpc/server";
import type { TypedEvent } from "@shared/typed-event-target";
import type { Patch } from "immer";
import type {
  ServiceState,
  ServiceStateUpdateEvent,
} from "../shared/service-state";
import { procedure } from "./orpc";

interface RegisteredState {
  serviceState: ServiceState<string, object>;
  unsubscribe: () => void;
}

interface StateOrchestratorOptions<StateMap extends SyncStateMap> {
  serviceStates: StateMap;
}

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
type SyncStateMap = Record<string, ServiceState<string, any>>;

export type SyncStateUpdateEvent = {
  version: number;
  patch: Patch[];
};

type SyncStateValuesSnapshot<StateMap extends SyncStateMap> = {
  [K in keyof StateMap & string]: StateMap[K]["~snapshot"];
};

export type SyncStateSnapshot<StateMap extends SyncStateMap> = {
  version: number;
  state: SyncStateValuesSnapshot<StateMap>;
};

export const stateSyncRouter = {
  getFullStateSnapshot: procedure.handler(({ context }) =>
    context.stateService.getAllStatesSnapshot(),
  ),
  subscribeToStateUpdates: procedure.handler(async function* ({
    signal,
    context,
  }) {
    for await (const payload of context.stateService.eventPublisher.subscribe(
      "state-update",
      { signal },
    )) {
      yield payload;
    }
  }),
};

export class StateOrchestrator<State extends SyncStateMap> {
  private readonly states = new Map<string, RegisteredState>();
  private stateVersion = 0;
  readonly eventPublisher = new EventPublisher<{
    "state-update": SyncStateUpdateEvent;
  }>({ maxBufferedEvents: Number.POSITIVE_INFINITY });

  constructor(options: StateOrchestratorOptions<State>) {
    for (const serviceState of Object.values(options.serviceStates)) {
      this.registerServiceState(serviceState);
    }
  }

  getAllStatesSnapshot(): SyncStateSnapshot<State> {
    const snapshot = {} as unknown as SyncStateValuesSnapshot<State>;
    for (const [key, serviceState] of this.states.entries()) {
      snapshot[key as keyof State & string] = structuredClone(
        serviceState.serviceState.state,
      );
    }
    return {
      version: this.stateVersion,
      state: snapshot,
    };
  }

  dispose(): void {
    for (const registered of this.states.values()) {
      registered.unsubscribe();
    }
    this.states.clear();
  }

  private registerServiceState(
    serviceState: ServiceState<string, object>,
  ): void {
    if (this.states.has(serviceState.key)) {
      throw new Error(`Duplicate state key registration: ${serviceState.key}`);
    }

    const handleStateChange = (
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      event: TypedEvent<ServiceStateUpdateEvent<any>>,
    ) => {
      const scopedPatch = event.payload.patch.map((patch) => ({
        ...patch,
        path: [serviceState.key, ...patch.path],
      }));
      this.stateVersion += 1;
      this.eventPublisher.publish("state-update", {
        version: this.stateVersion,
        patch: scopedPatch,
      });
    };

    serviceState.eventTarget.addEventListener(
      "state-update",
      handleStateChange,
    );

    const unsubscribe = () => {
      serviceState.eventTarget.removeEventListener(
        "state-update",
        handleStateChange,
      );
    };

    this.states.set(serviceState.key, {
      serviceState,
      unsubscribe,
    });
  }

  get "~stateMap"(): State {
    throw new Error("~stateMap should not be accessed directly");
  }
}
