export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export type ConnectionState = {
  status: ConnectionStatus;
  epoch: number;
};

let currentState: ConnectionState = { status: "connecting", epoch: 0 };
const listeners = new Set<() => void>();

export function getConnectionState(): ConnectionState {
  return currentState;
}

export function subscribeToConnectionState(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setConnectionStatus(status: ConnectionStatus): void {
  if (currentState.status === status) {
    return;
  }

  currentState = {
    status,
    epoch: status === "connected" ? currentState.epoch + 1 : currentState.epoch,
  };

  for (const listener of listeners) {
    listener();
  }
}
