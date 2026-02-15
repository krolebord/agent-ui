import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { RouterClient } from "@orpc/server";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { orpcRouter } from "src/main/orpc-router";

const { port1: clientPort, port2: serverPort } = new MessageChannel();

window.postMessage("start-orpc-client", "*", [serverPort]);

const link = new RPCLink({
  port: clientPort,
});

clientPort.start();

const orpcClient: RouterClient<typeof orpcRouter> = createORPCClient(link);

export const orpc = createTanstackQueryUtils(orpcClient);
