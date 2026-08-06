import type { orpcRouter } from "@main/orpc-router";
import { createORPCClient } from "@orpc/client";
import { RPCLink as MessagePortRPCLink } from "@orpc/client/message-port";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import type { RouterClient } from "@orpc/server";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
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

    return new MessagePortRPCLink({
      port: clientPort,
    });
  }

  let hasOpened = false;
  let shouldReloadOnReconnect = false;
  const websocket = new PartySocketWebSocket(getBrowserWebSocketUrl(), [], {
    maxEnqueuedMessages: 0,
  });

  websocket.addEventListener("open", () => {
    if (shouldReloadOnReconnect) {
      window.location.reload();
      return;
    }
    hasOpened = true;
  });

  websocket.addEventListener("close", () => {
    if (hasOpened) {
      shouldReloadOnReconnect = true;
    }
  });

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
