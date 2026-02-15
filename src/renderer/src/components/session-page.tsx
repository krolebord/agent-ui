import {
  type TerminalPaneHandle,
  TerminalPane,
} from "@renderer/components/terminal-pane";
import { AlertCircle } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { useAppState } from "./sync-state-provider";
import { useActiveSessionId } from "@renderer/hooks/use-active-session-id";
import { consumeEventIterator } from "@orpc/client";
import { orpc } from "@renderer/orpc-client";
import { toast } from "sonner";

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

  return <TerminalPage session={session} />;
}

function TerminalPage({ session }: { session: Session }) {
  const terminalRef = useRef<TerminalPaneHandle | null>(null);

  useEffect(() => {
    terminalRef.current?.clear();

    const cancel = consumeEventIterator(
      orpc.sessions.subscribeToSessionTerminal
        .call({
          sessionId: session.sessionId,
        })
        .then((stream) => {
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
          toast.error(`Terminal stream disconnected: ${message}`);
        },
      },
    );
    return () => void cancel();
  }, [session.sessionId]);

  const handleTerminalInput = useCallback(
    (data: string) => {
      void orpc.sessions.writeToSessionTerminal.call({
        sessionId: session.sessionId,
        data,
      });
    },
    [session.sessionId],
  );

  const handleTerminalResize = useCallback(
    (cols: number, rows: number) => {
      void orpc.sessions.resizeSessionTerminal.call({
        sessionId: session.sessionId,
        cols,
        rows,
      });
    },
    [session.sessionId],
  );

  const errorMessage =
    session.terminal.errorMessage || session.activity.warning || "";

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
