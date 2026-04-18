import { call } from "@orpc/server";
import type { TerminalEvent } from "@shared/terminal-types";
import { createDisposable } from "@shared/utils";
import { z } from "zod";
import log from "../logger";
import { procedure } from "../orpc";
import { TerminalManager } from "../terminal-manager";
import { commonSessionSchema, generateUniqueSessionId } from "./common";
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

const renameLocalTerminalSessionSchema = z.object({
  sessionId: z.string(),
  title: z.string().trim().min(1),
});

export const localTerminalRouter = {
  startSession: procedure
    .input(startLocalTerminalSessionSchema)
    .handler(async ({ input, context }) => {
      const sessionId = generateUniqueSessionId();
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
      };

      context.terminalManager.registerTerminal(sessionId);
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
  renameSession: procedure
    .input(renameLocalTerminalSessionSchema)
    .handler(async ({ input, context }) => {
      context.sessions.localTerminal.renameSession(
        input.sessionId,
        input.title,
      );
    }),
  subscribeToSessionTerminal: procedure
    .input(z.object({ sessionId: z.string() }))
    .handler(async function* ({ input, context, signal }) {
      const { snapshot, stream, isLive } =
        await context.terminalManager.subscribeToTerminalEvents(
          input.sessionId,
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
  writeToSessionTerminal: procedure
    .input(z.object({ sessionId: z.string(), data: z.string() }))
    .handler(async ({ input, context }) => {
      context.terminalManager.writeToTerminal(input.sessionId, input.data);
    }),
  resizeSessionTerminal: procedure
    .input(
      z.object({ sessionId: z.string(), cols: z.number(), rows: z.number() }),
    )
    .handler(async ({ input, context }) => {
      context.terminalManager.resizeTerminal(
        input.sessionId,
        input.cols,
        input.rows,
      );
    }),
};

interface LocalTerminalSessionRecord {
  terminalId: string;
  dispose: () => Promise<void>;
}

export class LocalTerminalSessionsManager {
  readonly liveSessions = new Map<string, LocalTerminalSessionRecord>();
  constructor(
    private readonly sessionsState: SessionServiceState,
    private readonly terminalManager: TerminalManager = new TerminalManager(),
  ) {
    for (const [sessionId, session] of Object.entries(
      this.sessionsState.state,
    )) {
      if (session.type === "local-terminal") {
        this.terminalManager.registerTerminal(sessionId);
      }
    }
  }

  private persistOfflineBuffer(sessionId: string, offlineBuffer?: string) {
    if (!offlineBuffer) {
      return;
    }

    this.sessionsState.updateState((state) => {
      const session = state[sessionId];
      if (!session || session.type !== "local-terminal") {
        return;
      }
      session.offlineBuffer = offlineBuffer;
    });
  }

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

    const terminal = this.terminalManager.startTerminal({
      terminalId: sessionId,
      launch: {
        runWithShell: true,
        cwd,
        cols,
        rows,
      },
      onStatusChange: (status) => {
        state.updateState((state) => {
          state[sessionId].status = status === "running" ? "idle" : status;
        });
      },
      onExit: (payload) => {
        void this.stopLiveSession(sessionId, payload.snapshot);
        state.updateState((state) => {
          state[sessionId].status = payload.errorMessage ? "error" : "stopped";
          state[sessionId].errorMessage = payload.errorMessage;
          state[sessionId].offlineBuffer = payload.snapshot;
        });
      },
    });
    disposable.addDisposable(() => terminal.stop());

    const session: LocalTerminalSessionRecord = {
      terminalId: sessionId,
      dispose: disposable.dispose,
    };
    this.liveSessions.set(sessionId, session);
    disposable.addDisposable(() => this.liveSessions.delete(sessionId));

    if (!this.terminalManager.getRuntime(sessionId)) {
      void disposable.dispose();
    }
  }

  async stopLiveSession(sessionId: string, offlineBuffer?: string) {
    const liveSession = this.liveSessions.get(sessionId);
    if (!liveSession) {
      return;
    }
    this.persistOfflineBuffer(
      sessionId,
      offlineBuffer || (await this.terminalManager.getSnapshot(sessionId)),
    );
    await liveSession.dispose();
  }

  async dispose(): Promise<void> {
    const sessionIds = [...this.liveSessions.keys()];
    await Promise.allSettled(
      sessionIds.map(async (sessionId) => {
        await this.stopLiveSession(sessionId);
      }),
    );
  }

  async deleteSession(sessionId: string) {
    await this.stopLiveSession(sessionId);
    await this.terminalManager.unregisterTerminal(sessionId);
    this.sessionsState.updateState((state) => {
      delete state[sessionId];
    });
  }

  renameSession(sessionId: string, title: string) {
    const nextTitle = title.trim();
    if (!nextTitle) {
      return;
    }

    this.sessionsState.updateState((state) => {
      const session = state[sessionId];
      if (!session || session.type !== "local-terminal") {
        return;
      }
      session.title = nextTitle;
    });
  }

  subscribeToTerminalEvents(sessionId: string, signal?: AbortSignal) {
    return this.terminalManager.subscribeToTerminalEvents(sessionId, signal);
  }
}
