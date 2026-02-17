import {
  type TerminalPaneHandle,
  TerminalPane,
} from "@renderer/components/terminal-pane";
import { AlertCircle } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { useAppState } from "./sync-state-provider";
import { useActiveSessionId } from "@renderer/hooks/use-active-session-id";
import { type ClientPromiseResult, consumeEventIterator } from "@orpc/client";
import { orpc } from "@renderer/orpc-client";
import { toast } from "sonner";
import type { TerminalEvent } from "@shared/terminal-types";

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
    default:
      return null;
  }
}

function TerminalPage({
  session,
  subscribe,
  writeToTerminal,
  resizeTerminal,
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
      writeToTerminal({
        sessionId: session.sessionId,
        data,
      });
    },
    [session.sessionId],
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
        />
      </div>
    </>
  );
}
