export class TypedEvent<T = unknown> extends Event {
  readonly payload: T;
  constructor(type: string, payload: T) {
    super(type);
    this.payload = payload;
  }
}

export type TypedEventTarget<T extends Record<string, unknown>> = {
  addEventListener: <K extends keyof T & string>(
    type: K,
    listener: (event: TypedEvent<T[K]>) => void,
  ) => void;
  removeEventListener: <K extends keyof T & string>(
    type: K,
    listener: (event: TypedEvent<T[K]>) => void,
  ) => void;
  dispatchEvent: <K extends keyof T & string>(type: K, payload: T[K]) => void;
};

export const createTypedEventTarget = <
  T extends Record<string, unknown>,
>(): TypedEventTarget<T> => {
  const eventTarget = new EventTarget();

  const addEventListener = <K extends keyof T & string>(
    type: K,
    listener: (event: TypedEvent<T[K]>) => void,
  ) => {
    eventTarget.addEventListener(type, listener as (e: Event) => void);
  };

  const removeEventListener = <K extends keyof T & string>(
    type: K,
    listener: (event: TypedEvent<T[K]>) => void,
  ) => {
    eventTarget.removeEventListener(type, listener as (e: Event) => void);
  };

  const dispatchEvent = <K extends keyof T & string>(
    type: K,
    payload: T[K],
  ) => {
    eventTarget.dispatchEvent(new TypedEvent(type, payload));
  };

  return {
    addEventListener,
    removeEventListener,
    dispatchEvent,
  };
};
