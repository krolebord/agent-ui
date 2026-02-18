import { Button } from "@renderer/components/ui/button";
import { Badge } from "@renderer/components/ui/badge";
import {
  type TerminalPaneHandle,
  TerminalPane,
} from "@renderer/components/terminal-pane";
import { AlertCircle } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useAppState } from "./sync-state-provider";
import { useActiveSessionId } from "@renderer/hooks/use-active-session-id";
import { type ClientPromiseResult, consumeEventIterator } from "@orpc/client";
import { orpc } from "@renderer/orpc-client";
import { toast } from "sonner";
import type { TerminalEvent } from "@shared/terminal-types";
import { useMutation } from "@tanstack/react-query";

function useActiveSession() {
  const activeSessionId = useActiveSessionId();
  const sessions = useAppState((state) => state.sessions);
  return activeSessionId ? (sessions[activeSessionId] ?? null) : null;
}

type Session = Exclude<ReturnType<typeof useActiveSession>, null>;

export function SessionPage() {
  const session = useActiveSession();

  if (!session) {
    return null;
  }

  switch (session.type) {
    case "claude-local-terminal":
      return (
        <TerminalPage
          session={session}
          subscribe={(sessionId) =>
            orpc.sessions.localClaude.subscribeToSessionTerminal.call({
              sessionId,
            })
          }
          writeToTerminal={
            orpc.sessions.localClaude.writeToSessionTerminal.call
          }
          resizeTerminal={orpc.sessions.localClaude.resizeSessionTerminal.call}
        />
      );
    case "local-terminal":
      return (
        <TerminalPage
          session={session}
          subscribe={(sessionId) =>
            orpc.sessions.localTerminal.subscribeToSessionTerminal.call({
              sessionId,
            })
          }
          writeToTerminal={
            orpc.sessions.localTerminal.writeToSessionTerminal.call
          }
          resizeTerminal={
            orpc.sessions.localTerminal.resizeSessionTerminal.call
          }
        />
      );
    case "ralph-loop":
      return <RalphLoopSessionPage session={session} />;
    default:
      return null;
  }
}

function RalphLoopSessionPage({
  session,
}: {
  session: Extract<Session, { type: "ralph-loop" }>;
}) {
  const stopLoop = useMutation(
    orpc.sessions.ralphLoop.stopLoop.mutationOptions(),
  );
  const resumeLoop = useMutation(
    orpc.sessions.ralphLoop.resumeSession.mutationOptions(),
  );
  const runSingleIteration = useMutation(
    orpc.sessions.ralphLoop.runSingleIteration.mutationOptions(),
  );

  const isRunning =
    session.status === "starting" ||
    session.status === "running" ||
    session.status === "stopping";
  const isTerminalCompletion =
    session.loopState.completion === "done" ||
    session.loopState.completion === "max_iterations";

  const loopReadOnly = session.loopState.autonomousEnabled;

  const [now, setNow] = useState(() => Date.now());
  const nextRunAt = session.loopState.nextRunAt;

  useEffect(() => {
    if (!nextRunAt) {
      return;
    }

    setNow(Date.now());
    const interval = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= nextRunAt) {
        clearInterval(interval);
      }
    }, 1000);

    return () => {
      clearInterval(interval);
    };
  }, [nextRunAt]);

  const nextRunLabel = session.loopState.nextRunAt
    ? `${Math.max(0, Math.ceil((session.loopState.nextRunAt - now) / 1000))}s`
    : "-";

  return (
    <TerminalPage
      session={session}
      subscribe={(sessionId) =>
        orpc.sessions.ralphLoop.subscribeToSessionTerminal.call({
          sessionId,
        })
      }
      writeToTerminal={orpc.sessions.ralphLoop.writeToSessionTerminal.call}
      resizeTerminal={orpc.sessions.ralphLoop.resizeSessionTerminal.call}
      readOnly={loopReadOnly}
      controls={
        <div className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-black/30 px-3 py-2">
          <Badge variant="secondary">
            Iteration {session.loopState.currentIteration}/
            {session.startupConfig.maxIterations}
          </Badge>
          <Badge variant="outline">
            Failures {session.loopState.consecutiveFailures}/
            {session.startupConfig.maxConsecutiveFailures}
          </Badge>
          <Badge variant="outline">Next run {nextRunLabel}</Badge>
          <Badge variant="outline">{session.loopState.completion}</Badge>

          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={
                stopLoop.isPending ||
                resumeLoop.isPending ||
                (session.loopState.autonomousEnabled
                  ? false
                  : isRunning || isTerminalCompletion)
              }
              onClick={() => {
                if (session.loopState.autonomousEnabled) {
                  stopLoop.mutate({ sessionId: session.sessionId });
                  return;
                }
                resumeLoop.mutate({ sessionId: session.sessionId });
              }}
            >
              {session.loopState.autonomousEnabled
                ? stopLoop.isPending
                  ? "Stopping..."
                  : "Stop Loop"
                : resumeLoop.isPending
                  ? "Resuming..."
                  : "Resume Loop"}
            </Button>
            <Button
              size="sm"
              disabled={runSingleIteration.isPending || isRunning}
              onClick={() => {
                runSingleIteration.mutate({ sessionId: session.sessionId });
              }}
            >
              {runSingleIteration.isPending
                ? "Running..."
                : "Run Single Iteration"}
            </Button>
          </div>
        </div>
      }
    />
  );
}

function TerminalPage({
  session,
  subscribe,
  writeToTerminal,
  resizeTerminal,
  readOnly,
  controls,
}: {
  session: Session;
  subscribe: (
    sessionId: string,
  ) => ClientPromiseResult<AsyncGenerator<TerminalEvent, void, unknown>, Error>;
  writeToTerminal: (opts: { sessionId: string; data: string }) => void;
  resizeTerminal: (opts: {
    sessionId: string;
    cols: number;
    rows: number;
  }) => void;
  readOnly?: boolean;
  controls?: ReactNode;
}) {
  const terminalRef = useRef<TerminalPaneHandle | null>(null);

  useEffect(() => {
    terminalRef.current?.clear();
    terminalRef.current?.write(session.bufferedOutput ?? "");

    const cancel = consumeEventIterator(
      subscribe(session.sessionId).then((stream) => {
        terminalRef.current?.focus();
        return stream;
      }),
      {
        onEvent(event) {
          switch (event.type) {
            case "data":
              terminalRef.current?.write(event.data);
              break;
            case "clear":
              terminalRef.current?.clear();
              break;
          }
        },
        onError(error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          if (message.includes("closed or aborted")) {
            return;
          }
          toast.error(`Terminal stream disconnected: ${message}`);
        },
      },
    );
    return () => void cancel();
  }, [session.sessionId]);

  const handleTerminalInput = useCallback(
    (data: string) => {
      if (readOnly) {
        return;
      }

      writeToTerminal({
        sessionId: session.sessionId,
        data,
      });
    },
    [session.sessionId, readOnly],
  );

  const handleTerminalResize = useCallback(
    (cols: number, rows: number) => {
      resizeTerminal({
        sessionId: session.sessionId,
        cols,
        rows,
      });
    },
    [session.sessionId],
  );

  const errorMessage = session.errorMessage || session.warningMessage || "";

  return (
    <>
      {controls}
      {errorMessage ? (
        <div className="mx-4 mt-4 flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
          <AlertCircle className="size-4" />
          <span>{errorMessage}</span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        <TerminalPane
          ref={terminalRef}
          onInput={handleTerminalInput}
          onResize={handleTerminalResize}
          readOnly={readOnly}
        />
      </div>
    </>
  );
}
