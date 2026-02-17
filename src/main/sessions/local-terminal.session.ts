import { randomUUID } from "node:crypto";
import { EventPublisher, call } from "@orpc/server";
import type { TerminalEvent } from "@shared/terminal-types";
import { createDisposable } from "@shared/utils";
import { z } from "zod";
import { withDebouncedRunner } from "../debounce-runner";
import log from "../logger";
import { procedure } from "../orpc";
import {
  type TerminalSession,
  createTerminalSession,
} from "../terminal-session";
import { commonSessionSchema } from "./common";
import type { SessionServiceState } from "./state";

export const localTerminalSessionSchema = commonSessionSchema.extend({
  type: z.literal("local-terminal"),
  startupConfig: z.object({
    cwd: z.string(),
  }),
});
export type LocalTerminalSessionData = z.infer<
  typeof localTerminalSessionSchema
>;

const startLocalTerminalSessionSchema = z.object({
  cwd: z.string(),
  cols: z.number().optional(),
  rows: z.number().optional(),
  sessionName: z
    .string()
    .optional()
    .transform((value) => value?.trim()),
});

export const localTerminalRouter = {
  startSession: procedure
    .input(startLocalTerminalSessionSchema)
    .handler(async ({ input, context }) => {
      const sessionId = randomUUID();
      const state = context.sessions.state;

      const newSession: LocalTerminalSessionData = {
        sessionId,
        type: "local-terminal",
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        status: "stopped",
        title: input.sessionName ?? "Local Terminal",
        startupConfig: {
          cwd: input.cwd,
        },
        bufferedOutput: "",
      };

      state.updateState((state) => {
        state[sessionId] = newSession;
      });

      await call(
        localTerminalRouter.resumeSession,
        { sessionId, cols: input.cols, rows: input.rows },
        {
          context,
        },
      );

      return { sessionId };
    }),
  resumeSession: procedure
    .input(
      z.object({
        sessionId: z.string(),
        cols: z.number().optional(),
        rows: z.number().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const sessionId = input.sessionId;
      const state = context.sessions.state;

      const session = state.state[sessionId];
      if (!session) {
        return;
      }

      context.sessions.localTerminal.startLiveSession({
        sessionId,
        cwd: session.startupConfig.cwd,
        cols: input.cols,
        rows: input.rows,
      });

      return { sessionId };
    }),
  stopLiveSession: procedure
    .input(z.object({ sessionId: z.string() }))
    .handler(async ({ input, context }) => {
      return await context.sessions.localTerminal.stopLiveSession(
        input.sessionId,
      );
    }),
  deleteSession: procedure
    .input(z.object({ sessionId: z.string() }))
    .handler(async ({ input, context }) => {
      return await context.sessions.localTerminal.deleteSession(
        input.sessionId,
      );
    }),
  subscribeToSessionTerminal: procedure
    .input(z.object({ sessionId: z.string() }))
    .handler(async function* ({ input, context, signal }) {
      const { bufferedOutput, stream, isLive } =
        context.sessions.localTerminal.subscribeToTerminalEvents(
          input.sessionId,
          signal,
        );

      if (isLive) {
        yield { type: "clear" } as TerminalEvent;
        if (bufferedOutput) {
          yield { type: "data", data: bufferedOutput } as TerminalEvent;
        }
      }
      for await (const event of stream) {
        yield event as TerminalEvent;
      }
    }),
  writeToSessionTerminal: procedure
    .input(z.object({ sessionId: z.string(), data: z.string() }))
    .handler(async ({ input, context }) => {
      const session = context.sessions.localTerminal.liveSessions.get(
        input.sessionId,
      );
      if (!session) {
        return;
      }
      session.terminal.write(input.data);
    }),
  resizeSessionTerminal: procedure
    .input(
      z.object({ sessionId: z.string(), cols: z.number(), rows: z.number() }),
    )
    .handler(async ({ input, context }) => {
      const session = context.sessions.localTerminal.liveSessions.get(
        input.sessionId,
      );
      if (!session) {
        return;
      }
      session.terminal.resize(input.cols, input.rows);
    }),
};

interface LocalTerminalSessionRecord {
  terminal: TerminalSession;
  dispose: () => Promise<void>;
}

export class LocalTerminalSessionsManager {
  readonly liveSessions = new Map<string, LocalTerminalSessionRecord>();
  private readonly eventPublisher = new EventPublisher<
    Record<string, TerminalEvent>
  >({
    maxBufferedEvents: 0,
  });

  constructor(private readonly sessionsState: SessionServiceState) {}

  startLiveSession({
    sessionId,
    cwd,
    cols,
    rows,
  }: {
    sessionId: string;
    cwd: string;
    cols?: number;
    rows?: number;
  }) {
    const liveSession = this.liveSessions.get(sessionId);
    const state = this.sessionsState;
    if (liveSession) {
      return;
    }

    const disposable = createDisposable({
      onError: (error) => {
        log.error("Error starting live session", error);
      },
    });

    const syncBufferedOutput = withDebouncedRunner(() => {
      state.updateState((state) => {
        state[sessionId].bufferedOutput =
          session?.terminal.bufferedOutput ?? "";
      });
    }, 500);
    disposable.addDisposable(() => syncBufferedOutput.dispose());

    const terminal = createTerminalSession({
      onData: ({ chunk }) => {
        this.eventPublisher.publish(sessionId, {
          type: "data",
          data: chunk,
        });

        syncBufferedOutput.schedule();
      },
      onStatusChange: (status) => {
        state.updateState((state) => {
          state[sessionId].status = status === "running" ? "idle" : status;
        });
        if (status === "stopped") {
          syncBufferedOutput.flush();
        }
      },
      onExit: (payload) => {
        void this.stopLiveSession(sessionId);
        state.updateState((state) => {
          state[sessionId].status = payload.errorMessage ? "error" : "stopped";
          state[sessionId].errorMessage = payload.errorMessage;
        });
        syncBufferedOutput.flush();
      },
    });
    disposable.addDisposable(() => terminal.stop());

    terminal.start({
      runWithShell: true,
      cwd,
      cols,
      rows,
    });

    const session: LocalTerminalSessionRecord = {
      terminal,
      dispose: disposable.dispose,
    };
    this.liveSessions.set(sessionId, session);
    disposable.addDisposable(() => this.liveSessions.delete(sessionId));
  }

  async stopLiveSession(sessionId: string) {
    const liveSession = this.liveSessions.get(sessionId);
    if (!liveSession) {
      return;
    }
    await liveSession.dispose();
  }

  async deleteSession(sessionId: string) {
    await this.stopLiveSession(sessionId);
    this.sessionsState.updateState((state) => {
      delete state[sessionId];
    });
  }

  subscribeToTerminalEvents(sessionId: string, signal?: AbortSignal) {
    const liveSession = this.liveSessions.get(sessionId);
    return {
      isLive: !!liveSession,
      bufferedOutput: liveSession?.terminal.bufferedOutput ?? "",
      stream: this.eventPublisher.subscribe(sessionId, { signal }),
    };
  }
}
