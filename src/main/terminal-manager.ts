import { EventPublisher } from "@orpc/server";
import type { TerminalEvent } from "@shared/terminal-types";
import { createDisposable } from "@shared/utils";
import { SerializeAddon } from "@xterm/addon-serialize";
import headlessXterm from "@xterm/headless";
import { z } from "zod";
import { procedure } from "./orpc";
import { assertProjectPathInteractionAllowed } from "./project-service";
import {
  createTerminalSession,
  type TerminalSessionStatus,
} from "./terminal-session";

const { Terminal: HeadlessTerminal } = headlessXterm;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const SNAPSHOT_SCROLLBACK = 200;

const terminalAccessSchema = z.object({
  interactionCwd: z.string().optional(),
});

type TerminalAccess = z.infer<typeof terminalAccessSchema>;

type TerminalExitPayload = {
  exitCode: number | null;
  signal?: number;
  errorMessage?: string;
};

type StartManagedTerminalOptions = {
  terminalId: string;
  launch: Parameters<ReturnType<typeof createTerminalSession>["start"]>[0];
  access?: TerminalAccess;
  transformOutputChunk?: (chunk: string) => string;
  onData?: (chunk: string, renderedChunk: string) => void;
  onStatusChange?: (status: TerminalSessionStatus) => void;
  onExit?: (payload: TerminalExitPayload) => void;
};

export interface ManagedTerminalRuntime {
  terminalId: string;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  clear: () => void;
  stop: () => Promise<void>;
  getSnapshot: () => string;
  readonly status: TerminalSessionStatus;
}

interface LiveManagedTerminal {
  terminalId: string;
  access: TerminalAccess;
  runtime: ManagedTerminalRuntime;
  dispose: () => Promise<void>;
}

function getSafeTerminalSize(cols?: number, rows?: number) {
  const safeCols =
    cols != null && Number.isFinite(cols) && cols > 0
      ? Math.floor(cols)
      : DEFAULT_COLS;
  const safeRows =
    rows != null && Number.isFinite(rows) && rows > 0
      ? Math.floor(rows)
      : DEFAULT_ROWS;

  return { cols: safeCols, rows: safeRows };
}

export const terminalsRouter = {
  subscribeToTerminal: procedure
    .input(z.object({ terminalId: z.string() }))
    .handler(async function* ({ input, context, signal }) {
      const interactionCwd = context.terminalManager.resolveInteractionCwd(
        input.terminalId,
      );
      assertProjectPathInteractionAllowed(interactionCwd, context);

      const { snapshot, stream, isLive } =
        context.terminalManager.subscribeToTerminalEvents(
          input.terminalId,
          signal,
        );

      if (isLive) {
        yield { type: "clear" } as TerminalEvent;
        if (snapshot) {
          yield { type: "data", data: snapshot } as TerminalEvent;
        }
      }

      for await (const event of stream) {
        yield event as TerminalEvent;
      }
    }),
  writeToTerminal: procedure
    .input(z.object({ terminalId: z.string(), data: z.string() }))
    .handler(async ({ input, context }) => {
      const interactionCwd = context.terminalManager.resolveInteractionCwd(
        input.terminalId,
      );
      assertProjectPathInteractionAllowed(interactionCwd, context);
      context.terminalManager.writeToTerminal(input.terminalId, input.data);
    }),
  resizeTerminal: procedure
    .input(
      z.object({
        terminalId: z.string(),
        cols: z.number(),
        rows: z.number(),
      }),
    )
    .handler(async ({ input, context }) => {
      const interactionCwd = context.terminalManager.resolveInteractionCwd(
        input.terminalId,
      );
      assertProjectPathInteractionAllowed(interactionCwd, context);
      context.terminalManager.resizeTerminal(
        input.terminalId,
        input.cols,
        input.rows,
      );
    }),
};

export class TerminalManager {
  private readonly liveTerminals = new Map<string, LiveManagedTerminal>();
  private readonly terminalAccess = new Map<string, TerminalAccess>();
  private readonly eventPublisher = new EventPublisher<
    Record<string, TerminalEvent>
  >({
    maxBufferedEvents: 0,
  });

  registerTerminal(terminalId: string, access?: TerminalAccess) {
    this.terminalAccess.set(
      terminalId,
      terminalAccessSchema.parse(access ?? {}),
    );
  }

  async unregisterTerminal(terminalId: string) {
    await this.stopTerminal(terminalId);
    this.terminalAccess.delete(terminalId);
  }

  resolveInteractionCwd(terminalId: string): string | undefined {
    return (
      this.liveTerminals.get(terminalId)?.access.interactionCwd ??
      this.terminalAccess.get(terminalId)?.interactionCwd
    );
  }

  getRuntime(terminalId: string): ManagedTerminalRuntime | null {
    return this.liveTerminals.get(terminalId)?.runtime ?? null;
  }

  startTerminal({
    terminalId,
    launch,
    access,
    transformOutputChunk,
    onData,
    onStatusChange,
    onExit,
  }: StartManagedTerminalOptions): ManagedTerminalRuntime {
    const existing = this.liveTerminals.get(terminalId);
    if (existing) {
      if (access) {
        existing.access = terminalAccessSchema.parse(access);
        this.terminalAccess.set(terminalId, existing.access);
      }
      if (launch.cols != null && launch.rows != null) {
        existing.runtime.resize(launch.cols, launch.rows);
      }
      return existing.runtime;
    }

    const normalizedAccess = terminalAccessSchema.parse(access ?? {});
    this.terminalAccess.set(terminalId, normalizedAccess);

    const { cols, rows } = getSafeTerminalSize(launch.cols, launch.rows);
    const headless = new HeadlessTerminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: SNAPSHOT_SCROLLBACK,
    });
    const serializeAddon = new SerializeAddon();
    headless.loadAddon(serializeAddon as never);

    let sessionStatus: TerminalSessionStatus = "stopped";

    const disposable = createDisposable({
      onError: () => {},
    });

    const terminal = createTerminalSession({
      onData: ({ chunk }) => {
        const renderedChunk = transformOutputChunk?.(chunk) ?? chunk;
        onData?.(chunk, renderedChunk);
        if (!renderedChunk) {
          return;
        }

        headless.write(renderedChunk);
        this.eventPublisher.publish(terminalId, {
          type: "data",
          data: renderedChunk,
        });
      },
      onStatusChange: (status) => {
        sessionStatus = status;
        onStatusChange?.(status);
      },
      onExit: (payload) => {
        this.liveTerminals.delete(terminalId);
        onExit?.(payload);
      },
    });

    const runtime: ManagedTerminalRuntime = {
      terminalId,
      write: (data) => {
        terminal.write(data);
      },
      resize: (nextCols, nextRows) => {
        const size = getSafeTerminalSize(nextCols, nextRows);
        terminal.resize(size.cols, size.rows);
        headless.resize(size.cols, size.rows);
      },
      clear: () => {
        terminal.clear();
      },
      stop: async () => {
        await disposable.dispose();
      },
      getSnapshot: () => {
        return serializeAddon.serialize({
          scrollback: SNAPSHOT_SCROLLBACK,
        });
      },
      get status() {
        return sessionStatus;
      },
    };

    disposable.addDisposable(() => terminal.stop());
    disposable.addDisposable(() => {
      this.liveTerminals.delete(terminalId);
    });

    const liveTerminal: LiveManagedTerminal = {
      terminalId,
      access: normalizedAccess,
      runtime,
      dispose: disposable.dispose,
    };
    this.liveTerminals.set(terminalId, liveTerminal);

    terminal.start({
      ...launch,
      cols,
      rows,
    });

    return runtime;
  }

  async stopTerminal(terminalId: string) {
    const liveTerminal = this.liveTerminals.get(terminalId);
    if (!liveTerminal) {
      return;
    }
    await liveTerminal.dispose();
  }

  writeToTerminal(terminalId: string, data: string) {
    this.liveTerminals.get(terminalId)?.runtime.write(data);
  }

  resizeTerminal(terminalId: string, cols: number, rows: number) {
    this.liveTerminals.get(terminalId)?.runtime.resize(cols, rows);
  }

  subscribeToTerminalEvents(terminalId: string, signal?: AbortSignal) {
    const liveTerminal = this.liveTerminals.get(terminalId);
    const stream = this.eventPublisher.subscribe(terminalId, { signal });
    return {
      isLive: !!liveTerminal,
      snapshot: liveTerminal?.runtime.getSnapshot() ?? "",
      stream,
    };
  }

  async dispose(): Promise<void> {
    const terminalIds = [...this.liveTerminals.keys()];
    await Promise.allSettled(
      terminalIds.map(async (terminalId) => {
        await this.stopTerminal(terminalId);
      }),
    );
  }
}
