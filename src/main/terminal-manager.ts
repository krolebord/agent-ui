import { EventPublisher } from "@orpc/server";
import type { TerminalEvent } from "@shared/terminal-types";
import { createDeferredPromise } from "@shared/utils";
import { SerializeAddon } from "@xterm/addon-serialize";
import headlessXterm from "@xterm/headless";
import { z } from "zod";
import { MAX_PASTED_FILE_BYTES } from "../shared/pasted-files";
import { procedure } from "./orpc";
import { savePastedFile } from "./pasted-files";
import { assertProjectPathInteractionAllowed } from "./project-service";
import {
  createTerminalSession,
  type TerminalExitPayload,
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

type ManagedTerminalExitPayload = TerminalExitPayload & {
  snapshot?: string;
};

type StartManagedTerminalOptions = {
  terminalId: string;
  launch: Parameters<ReturnType<typeof createTerminalSession>["start"]>[0];
  access?: TerminalAccess;
  transformInput?: (data: string) => string;
  transformOutputChunk?: (chunk: string) => string;
  onData?: (chunk: string, renderedChunk: string) => void;
  onStatusChange?: (status: TerminalSessionStatus) => void;
  onExit?: (payload: ManagedTerminalExitPayload) => void;
};

export interface ManagedTerminalRuntime {
  terminalId: string;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  clear: () => void;
  stop: () => Promise<void>;
  getSnapshot: () => Promise<string>;
  readonly status: TerminalSessionStatus;
}

interface LiveManagedTerminal {
  terminalId: string;
  access: TerminalAccess;
  state: "live" | "stopping";
  runtime: ManagedTerminalRuntime;
  terminal: ReturnType<typeof createTerminalSession>;
  completion: ReturnType<typeof createDeferredPromise<void>>;
  stopPromise: Promise<void> | null;
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
        await context.terminalManager.subscribeToTerminalEvents(
          input.terminalId,
          signal,
        );

      // Live terminals replay from the running PTY, stopped ones from the
      // scrollback stored when they exited.
      const replay = isLive
        ? snapshot
        : await context.sessionBuffers.get(input.terminalId);

      yield { type: "clear" } as TerminalEvent;
      if (replay) {
        yield { type: "data", data: replay } as TerminalEvent;
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
  uploadPastedFile: procedure
    .input(
      z.object({
        terminalId: z.string(),
        // Base64 is ~4/3 of the decoded size; savePastedFile enforces the
        // exact byte limit after decoding.
        base64Data: z
          .string()
          .min(1)
          .max(Math.ceil((MAX_PASTED_FILE_BYTES * 4) / 3) + 4),
        fileName: z.string().max(500).optional(),
        mimeType: z.string().max(255).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const interactionCwd = context.terminalManager.resolveInteractionCwd(
        input.terminalId,
      );
      assertProjectPathInteractionAllowed(interactionCwd, context);
      return await savePastedFile({
        base64Data: input.base64Data,
        fileName: input.fileName,
        mimeType: input.mimeType,
      });
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

  async getSnapshot(terminalId: string): Promise<string> {
    return (
      (await this.liveTerminals.get(terminalId)?.runtime.getSnapshot()) ?? ""
    );
  }

  async startTerminal({
    terminalId,
    launch,
    access,
    transformInput,
    transformOutputChunk,
    onData,
    onStatusChange,
    onExit,
  }: StartManagedTerminalOptions): Promise<ManagedTerminalRuntime> {
    while (true) {
      const existing = this.liveTerminals.get(terminalId);
      if (!existing) {
        break;
      }
      if (access) {
        existing.access = terminalAccessSchema.parse(access);
        this.terminalAccess.set(terminalId, existing.access);
      }
      if (existing.state === "live") {
        if (launch.cols != null && launch.rows != null) {
          existing.runtime.resize(launch.cols, launch.rows);
        }
        return existing.runtime;
      }

      // A same-ID restart is serialized behind the authoritative exit cleanup.
      await (existing.stopPromise ?? existing.completion.promise);
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
    let pendingHeadlessWrite = Promise.resolve();

    let liveTerminal: LiveManagedTerminal;
    const terminal = createTerminalSession({
      onData: ({ chunk }) => {
        const renderedChunk = transformOutputChunk?.(chunk) ?? chunk;
        onData?.(chunk, renderedChunk);
        if (!renderedChunk) {
          return;
        }

        pendingHeadlessWrite = pendingHeadlessWrite
          .then(
            () =>
              new Promise<void>((resolve) => {
                headless.write(renderedChunk, () => resolve());
              }),
          )
          .catch(() => {});
        this.eventPublisher.publish(terminalId, {
          type: "data",
          data: renderedChunk,
        });
      },
      onStatusChange: (status) => {
        sessionStatus = status;
        onStatusChange?.(status);
      },
      onExit: async (payload) => {
        liveTerminal.state = "stopping";
        try {
          await pendingHeadlessWrite.catch(() => undefined);
          const snapshot = serializeAddon.serialize({
            scrollback: SNAPSHOT_SCROLLBACK,
          });
          onExit?.({
            ...payload,
            snapshot,
          });
        } finally {
          if (this.liveTerminals.get(terminalId) === liveTerminal) {
            this.liveTerminals.delete(terminalId);
          }
          liveTerminal.completion.resolve(undefined);
        }
      },
    });

    const runtime: ManagedTerminalRuntime = {
      terminalId,
      write: (data) => {
        const transformedData = transformInput?.(data) ?? data;
        if (transformedData) {
          terminal.write(transformedData);
        }
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
        await this.stopManagedTerminal(liveTerminal);
      },
      getSnapshot: async () => {
        await pendingHeadlessWrite;
        return serializeAddon.serialize({
          scrollback: SNAPSHOT_SCROLLBACK,
        });
      },
      get status() {
        return sessionStatus;
      },
    };

    liveTerminal = {
      terminalId,
      access: normalizedAccess,
      state: "live",
      runtime,
      terminal,
      completion: createDeferredPromise<void>(),
      stopPromise: null,
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
    await this.stopManagedTerminal(liveTerminal);
  }

  private stopManagedTerminal(
    liveTerminal: LiveManagedTerminal,
  ): Promise<void> {
    if (liveTerminal.stopPromise) {
      return liveTerminal.stopPromise;
    }
    if (liveTerminal.state === "stopping") {
      return liveTerminal.completion.promise;
    }

    liveTerminal.state = "stopping";
    liveTerminal.stopPromise = liveTerminal.terminal.stop().finally(() => {
      // TerminalSession normally removes the entry through its awaited onExit
      // callback. Keep this fallback for a runtime that completes without one.
      if (this.liveTerminals.get(liveTerminal.terminalId) === liveTerminal) {
        this.liveTerminals.delete(liveTerminal.terminalId);
      }
      liveTerminal.completion.resolve(undefined);
    });
    return liveTerminal.stopPromise;
  }

  writeToTerminal(terminalId: string, data: string) {
    this.liveTerminals.get(terminalId)?.runtime.write(data);
  }

  resizeTerminal(terminalId: string, cols: number, rows: number) {
    this.liveTerminals.get(terminalId)?.runtime.resize(cols, rows);
  }

  async subscribeToTerminalEvents(terminalId: string, signal?: AbortSignal) {
    const liveTerminal = this.liveTerminals.get(terminalId);
    const stream = this.eventPublisher.subscribe(terminalId, { signal });
    return {
      isLive: !!liveTerminal,
      snapshot: liveTerminal ? await liveTerminal.runtime.getSnapshot() : "",
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
