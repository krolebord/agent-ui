import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachBrowserWakeReconnect,
  isBrowserWebSocketLive,
  nudgeReconnectIfDisconnected,
} from "../../src/renderer/src/lib/browser-websocket";

function createSocket(readyState: number) {
  return {
    readyState,
    reconnect: vi.fn(),
  };
}

describe("isBrowserWebSocketLive", () => {
  it("treats an open or connecting socket as live", () => {
    expect(isBrowserWebSocketLive(WebSocket.OPEN)).toBe(true);
    expect(isBrowserWebSocketLive(WebSocket.CONNECTING)).toBe(true);
  });

  it("treats a closing or closed socket as down", () => {
    expect(isBrowserWebSocketLive(WebSocket.CLOSING)).toBe(false);
    expect(isBrowserWebSocketLive(WebSocket.CLOSED)).toBe(false);
  });
});

describe("nudgeReconnectIfDisconnected", () => {
  it("reconnects a closed socket", () => {
    const socket = createSocket(WebSocket.CLOSED);

    expect(nudgeReconnectIfDisconnected(socket)).toBe(true);
    expect(socket.reconnect).toHaveBeenCalledOnce();
  });

  it("reconnects a closing socket", () => {
    const socket = createSocket(WebSocket.CLOSING);

    expect(nudgeReconnectIfDisconnected(socket)).toBe(true);
    expect(socket.reconnect).toHaveBeenCalledOnce();
  });

  it("leaves an open socket alone", () => {
    const socket = createSocket(WebSocket.OPEN);

    expect(nudgeReconnectIfDisconnected(socket)).toBe(false);
    expect(socket.reconnect).not.toHaveBeenCalled();
  });

  it("leaves a connecting socket alone", () => {
    const socket = createSocket(WebSocket.CONNECTING);

    expect(nudgeReconnectIfDisconnected(socket)).toBe(false);
    expect(socket.reconnect).not.toHaveBeenCalled();
  });
});

describe("attachBrowserWakeReconnect", () => {
  const documentListeners = new Map<string, Set<() => void>>();
  const windowListeners = new Map<string, Set<() => void>>();
  let visibilityState: DocumentVisibilityState = "visible";

  afterEach(() => {
    documentListeners.clear();
    windowListeners.clear();
    vi.unstubAllGlobals();
  });

  function installDom(initialVisibility: DocumentVisibilityState) {
    visibilityState = initialVisibility;
    documentListeners.clear();
    windowListeners.clear();

    vi.stubGlobal("document", {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener(type: string, listener: () => void) {
        const listeners = documentListeners.get(type) ?? new Set();
        listeners.add(listener);
        documentListeners.set(type, listeners);
      },
      removeEventListener(type: string, listener: () => void) {
        documentListeners.get(type)?.delete(listener);
      },
    });

    vi.stubGlobal("window", {
      addEventListener(type: string, listener: () => void) {
        const listeners = windowListeners.get(type) ?? new Set();
        listeners.add(listener);
        windowListeners.set(type, listeners);
      },
      removeEventListener(type: string, listener: () => void) {
        windowListeners.get(type)?.delete(listener);
      },
    });
  }

  function emit(target: Map<string, Set<() => void>>, type: string) {
    for (const listener of target.get(type) ?? []) {
      listener();
    }
  }

  it("reconnects a closed socket when the tab becomes visible", () => {
    installDom("hidden");
    const socket = createSocket(WebSocket.CLOSED);
    const detach = attachBrowserWakeReconnect(socket);

    visibilityState = "visible";
    emit(documentListeners, "visibilitychange");

    expect(socket.reconnect).toHaveBeenCalledOnce();
    detach();
  });

  it("does not reconnect while the tab stays hidden", () => {
    installDom("hidden");
    const socket = createSocket(WebSocket.CLOSED);
    const detach = attachBrowserWakeReconnect(socket);

    emit(documentListeners, "visibilitychange");

    expect(socket.reconnect).not.toHaveBeenCalled();
    detach();
  });

  it("reconnects a closed socket when the network comes back", () => {
    installDom("visible");
    const socket = createSocket(WebSocket.CLOSED);
    const detach = attachBrowserWakeReconnect(socket);

    emit(windowListeners, "online");

    expect(socket.reconnect).toHaveBeenCalledOnce();
    detach();
  });

  it("does not reconnect a live socket on wake", () => {
    installDom("hidden");
    const socket = createSocket(WebSocket.OPEN);
    const detach = attachBrowserWakeReconnect(socket);

    visibilityState = "visible";
    emit(documentListeners, "visibilitychange");
    emit(windowListeners, "online");

    expect(socket.reconnect).not.toHaveBeenCalled();
    detach();
  });

  it("stops listening after detach", () => {
    installDom("hidden");
    const socket = createSocket(WebSocket.CLOSED);
    const detach = attachBrowserWakeReconnect(socket);
    detach();

    visibilityState = "visible";
    emit(documentListeners, "visibilitychange");
    emit(windowListeners, "online");

    expect(socket.reconnect).not.toHaveBeenCalled();
  });
});
