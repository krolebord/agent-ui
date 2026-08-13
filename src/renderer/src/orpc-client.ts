import type { orpcRouter } from "@main/orpc-router";
import { createORPCClient } from "@orpc/client";
import { RPCLink as MessagePortRPCLink } from "@orpc/client/message-port";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import type { RouterClient } from "@orpc/server";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import {
  attachBrowserWakeReconnect,
  BROWSER_WS_MIN_RECONNECTION_DELAY_MS,
} from "@renderer/lib/browser-websocket";
import { setConnectionStatus } from "@renderer/lib/connection-state";
import { WebSocket as PartySocketWebSocket } from "partysocket";

function getBrowserWebSocketUrl() {
  const params = new URLSearchParams(window.location.search);
  const configuredUrl = params.get("agentUiWs");
  if (configuredUrl) {
    return configuredUrl;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/rpc`;
}

function createORPCLink() {
  if (navigator.userAgent.includes("Electron")) {
    const { port1: clientPort, port2: serverPort } = new MessageChannel();

    window.postMessage("start-orpc-client", "*", [serverPort]);
    clientPort.start();

    // The message port lives as long as the window, so it is connected once
    // and never drops.
    setConnectionStatus("connected");

    return new MessagePortRPCLink({
      port: clientPort,
    });
  }

  const websocket = new PartySocketWebSocket(getBrowserWebSocketUrl(), [], {
    maxEnqueuedMessages: 0,
    minReconnectionDelay: BROWSER_WS_MIN_RECONNECTION_DELAY_MS,
  });

  // partysocket reconnects on its own; subscribers re-attach their streams and
  // reload the state snapshot when the epoch bumps. Wake/online only nudges
  // when the socket is already down, so a live tab is not torn down.
  websocket.addEventListener("open", () => {
    setConnectionStatus("connected");
  });

  websocket.addEventListener("close", () => {
    setConnectionStatus("disconnected");
  });

  attachBrowserWakeReconnect(websocket);

  return new WebSocketRPCLink({
    websocket: websocket as unknown as Pick<
      WebSocket,
      "addEventListener" | "readyState" | "removeEventListener" | "send"
    >,
  });
}

const orpcClient: RouterClient<typeof orpcRouter> = createORPCClient(
  createORPCLink(),
);

export const orpc = createTanstackQueryUtils(orpcClient);
