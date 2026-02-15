import Store from "electron-store";
import type { ZodIssue, ZodType } from "zod";
import type { ServiceState } from "../shared/service-state";
import { withDebouncedRunner } from "./debounce-runner";

const PERSISTENCE_DEBOUNCE_MS = 75;
const STORE_NAME = "claude-ui";
const SCHEMA_VERSION_KEY = "schemaVersion";

export interface PersistenceErrorEvent {
  key: string;
  phase: "load" | "persist";
  error: unknown;
  value?: unknown;
  issues?: ZodIssue[];
}

export interface PersistenceRegistration<
  K extends string = string,
  TState extends object = object,
  TPersisted extends Partial<TState> = TState,
> {
  serviceState: ServiceState<K, TState>;
  schema: ZodType<TPersisted>;
  toPersisted?: (state: TState) => TPersisted;
  fromPersisted?: (defaults: TState, persisted: TPersisted) => TState;
  debounceMs?: number;
  onError?: (event: PersistenceErrorEvent) => void;
}

interface RegisteredPersistence {
  flushPersistence: () => void;
  unsubscribe: () => void;
}

function reportPersistenceError(
  registration: Pick<PersistenceRegistration, "onError">,
  event: PersistenceErrorEvent,
): void {
  try {
    registration.onError?.(event);
  } catch {
    // Keep state operations resilient even if error handlers throw.
  }
}

export function defineStatePersistence<
  K extends string,
  TState extends object,
  TPersisted extends Partial<TState> = TState,
>(options: PersistenceRegistration<K, TState, TPersisted>) {
  return options;
}

export class PersistenceOrchestrator {
  private readonly registrations = new Map<string, RegisteredPersistence>();
  private readonly store: Store<Record<string, unknown>>;
  private readonly schemaVersion: number | null;

  constructor(options: { schemaVersion: number }) {
    this.schemaVersion =
      typeof options.schemaVersion === "number" ? options.schemaVersion : null;

    this.store = new Store<Record<string, unknown>>({
      name: STORE_NAME,
      defaults: {
        [SCHEMA_VERSION_KEY]: this.schemaVersion,
      },
    });

    this.ensureSchemaVersion();
  }

  flushAll(): void {
    for (const registration of this.registrations.values()) {
      registration.flushPersistence();
    }
  }

  dispose(): void {
    for (const registration of this.registrations.values()) {
      registration.unsubscribe();
      registration.flushPersistence();
    }
    this.registrations.clear();
  }

  registerAndHydrate<
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    Registration extends PersistenceRegistration<string, any, any>,
  >(registration: Registration): void {
    const key = registration.serviceState.key;
    if (this.registrations.has(key)) {
      throw new Error(`Duplicate persistence registration: ${key}`);
    }

    this.loadPersistedState(registration);

    let dirty = false;
    const debounceMs = Math.max(
      0,
      registration.debounceMs ?? PERSISTENCE_DEBOUNCE_MS,
    );

    const flushInternal = (): void => {
      if (!dirty) {
        return;
      }

      dirty = false;
      this.persistState(registration);
    };

    const debouncedPersistence = withDebouncedRunner(flushInternal, debounceMs);
    const handleStateChange = (): void => {
      dirty = true;
      debouncedPersistence.schedule();
    };

    registration.serviceState.eventTarget.addEventListener(
      "state-update",
      handleStateChange,
    );

    this.registrations.set(key, {
      flushPersistence: () => debouncedPersistence.flush(),
      unsubscribe: () => {
        debouncedPersistence.flush();
        debouncedPersistence.dispose();
        registration.serviceState.eventTarget.removeEventListener(
          "state-update",
          handleStateChange,
        );
      },
    });
  }

  private loadPersistedState(registration: PersistenceRegistration): void {
    try {
      const loaded = this.store.get(registration.serviceState.key);
      const parsed = registration.schema.safeParse(loaded);
      if (!parsed.success) {
        reportPersistenceError(registration, {
          key: registration.serviceState.key,
          phase: "load",
          error: new Error("Persisted state failed schema validation"),
          value: loaded,
          issues: parsed.error.issues,
        });
        return;
      }

      const defaults = registration.serviceState.state;
      const hydrated = registration.fromPersisted
        ? registration.fromPersisted(defaults as never, parsed.data as never)
        : (parsed.data as never);

      registration.serviceState.updateState(() =>
        shallowMerge(defaults as never, hydrated as never),
      );
    } catch (error) {
      reportPersistenceError(registration, {
        key: registration.serviceState.key,
        phase: "load",
        error,
      });
    }
  }

  private persistState(registration: PersistenceRegistration): void {
    try {
      const stateSnapshot = registration.serviceState.state;

      const persistedCandidate = registration.toPersisted
        ? registration.toPersisted(stateSnapshot as never)
        : (stateSnapshot as never);
      const parsed = registration.schema.safeParse(persistedCandidate);
      if (!parsed.success) {
        reportPersistenceError(registration, {
          key: registration.serviceState.key,
          phase: "persist",
          error: new Error("Selected state failed schema validation"),
          value: persistedCandidate,
          issues: parsed.error.issues,
        });
        return;
      }

      this.store.set(registration.serviceState.key, parsed.data);
    } catch (error) {
      reportPersistenceError(registration, {
        key: registration.serviceState.key,
        phase: "persist",
        error,
      });
    }
  }

  private ensureSchemaVersion(): void {
    if (this.schemaVersion === null) {
      return;
    }

    const currentVersion = this.store.get(SCHEMA_VERSION_KEY);
    if (currentVersion === this.schemaVersion) {
      return;
    }

    this.store.set(SCHEMA_VERSION_KEY, this.schemaVersion);
  }
}

function shallowMerge<T extends object>(a: T, b: T): T {
  if (
    typeof a !== "object" ||
    a === null ||
    typeof b !== "object" ||
    b === null
  ) {
    return b;
  }

  if (Array.isArray(a)) {
    return b;
  }

  return {
    ...a,
    ...b,
  };
}
