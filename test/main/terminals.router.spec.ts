import { call } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import type { Services } from "../../src/main/create-services";
import {
  createInMemorySessionBufferStore,
  type SessionBufferStore,
} from "../../src/main/database/session-buffer-store";
import { terminalsRouter } from "../../src/main/terminal-manager";
import type { TerminalEvent } from "../../src/shared/terminal-types";

function createContext(options: {
  isLive: boolean;
  snapshot?: string;
  events?: TerminalEvent[];
  sessionBuffers?: SessionBufferStore;
}) {
  const events = options.events ?? [];
  const terminalManager = {
    resolveInteractionCwd: vi.fn(() => null),
    subscribeToTerminalEvents: vi.fn(async () => ({
      isLive: options.isLive,
      snapshot: options.snapshot ?? "",
      stream: (async function* () {
        yield* events;
      })(),
    })),
  };

  return {
    terminalManager,
    projectsState: { state: [] },
    sessionBuffers:
      options.sessionBuffers ?? createInMemorySessionBufferStore(),
  } as unknown as Services;
}

async function collect(iterator: AsyncIterable<TerminalEvent>) {
  const collected: TerminalEvent[] = [];
  for await (const event of iterator) {
    collected.push(event);
  }
  return collected;
}

describe("terminals.subscribeToTerminal", () => {
  it("replays the live PTY snapshot for a running terminal", async () => {
    const sessionBuffers = createInMemorySessionBufferStore();
    await sessionBuffers.set("terminal-1", "stale stored output");

    const events = await collect(
      await call(
        terminalsRouter.subscribeToTerminal,
        { terminalId: "terminal-1" },
        {
          context: createContext({
            isLive: true,
            snapshot: "live output",
            sessionBuffers,
          }),
        },
      ),
    );

    expect(events).toEqual([
      { type: "clear" },
      { type: "data", data: "live output" },
    ]);
  });

  it("replays the stored buffer for a stopped session", async () => {
    const sessionBuffers = createInMemorySessionBufferStore();
    await sessionBuffers.set("terminal-1", "offline output");

    const events = await collect(
      await call(
        terminalsRouter.subscribeToTerminal,
        { terminalId: "terminal-1" },
        { context: createContext({ isLive: false, sessionBuffers }) },
      ),
    );

    expect(events).toEqual([
      { type: "clear" },
      { type: "data", data: "offline output" },
    ]);
  });

  it("emits only a clear when nothing has been captured yet", async () => {
    const events = await collect(
      await call(
        terminalsRouter.subscribeToTerminal,
        { terminalId: "terminal-1" },
        { context: createContext({ isLive: false }) },
      ),
    );

    expect(events).toEqual([{ type: "clear" }]);
  });

  it("forwards live events after the replay", async () => {
    const events = await collect(
      await call(
        terminalsRouter.subscribeToTerminal,
        { terminalId: "terminal-1" },
        {
          context: createContext({
            isLive: true,
            snapshot: "replayed",
            events: [{ type: "data", data: "streamed" }],
          }),
        },
      ),
    );

    expect(events).toEqual([
      { type: "clear" },
      { type: "data", data: "replayed" },
      { type: "data", data: "streamed" },
    ]);
  });
});
