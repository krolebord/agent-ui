export const BROWSER_WS_MIN_RECONNECTION_DELAY_MS = 1_000;

export type WakeReconnectSocket = {
  readyState: number;
  reconnect: () => void;
};

export function isBrowserWebSocketLive(readyState: number): boolean {
  return readyState === WebSocket.OPEN || readyState === WebSocket.CONNECTING;
}

export function nudgeReconnectIfDisconnected(
  socket: WakeReconnectSocket,
): boolean {
  if (isBrowserWebSocketLive(socket.readyState)) {
    return false;
  }
  socket.reconnect();
  return true;
}

export function attachBrowserWakeReconnect(
  socket: WakeReconnectSocket,
): () => void {
  const onWake = () => {
    nudgeReconnectIfDisconnected(socket);
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      onWake();
    }
  };

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("online", onWake);

  return () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("online", onWake);
  };
}
