/**
 * Browser-only WebSocket reconnect policy.
 *
 * PartySocket already retries on close, but its default first delay is 3s and
 * it does not listen for tab-wake or network-restore. After sleep or a
 * backgrounded phone tab the socket is often already CLOSED and sitting in
 * backoff; calling reconnect() resets that ladder so the next attempt is
 * immediate. An OPEN or CONNECTING socket is left alone — tearing down a
 * healthy session is how reconnects start feeling slow.
 */

/** PartySocket's built-in default is 3000ms. */
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
