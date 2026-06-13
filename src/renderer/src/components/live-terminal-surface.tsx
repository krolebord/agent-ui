import { consumeEventIterator } from "@orpc/client";
import {
  TerminalPane,
  type TerminalPaneHandle,
} from "@renderer/components/terminal-pane";
import { getTerminalSize } from "@renderer/hooks/use-terminal-size";
import { orpc } from "@renderer/orpc-client";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";

export function LiveTerminalSurface({
  terminalId,
  active = true,
  readOnly = false,
  trackGlobalSize = true,
  initialBuffer,
  attachKey = "default",
}: {
  terminalId: string;
  active?: boolean;
  readOnly?: boolean;
  trackGlobalSize?: boolean;
  initialBuffer?: string;
  attachKey?: string;
}) {
  const terminalRef = useRef<TerminalPaneHandle | null>(null);

  useEffect(() => {
    attachKey;
    terminalRef.current?.clear();
    if (initialBuffer) {
      terminalRef.current?.write(initialBuffer);
    }

    const cancel = consumeEventIterator(
      orpc.terminals.subscribeToTerminal.call({ terminalId }),
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
  }, [attachKey, initialBuffer, terminalId]);

  useEffect(() => {
    if (!active) {
      return;
    }

    terminalRef.current?.autofit();
    if (!readOnly) {
      terminalRef.current?.focus();
    }
  }, [active, readOnly]);

  useEffect(() => {
    if (!active || !trackGlobalSize) {
      return;
    }

    const { cols, rows } = getTerminalSize();
    void orpc.terminals.resizeTerminal.call({
      terminalId,
      cols,
      rows,
    });
  }, [active, terminalId, trackGlobalSize]);

  const handleInput = useCallback(
    (data: string) => {
      if (!active || readOnly) {
        return;
      }

      void orpc.terminals.writeToTerminal.call({
        terminalId,
        data,
      });
    },
    [active, readOnly, terminalId],
  );

  const handleResize = useCallback(
    (cols: number, rows: number) => {
      if (!active) {
        return;
      }

      void orpc.terminals.resizeTerminal.call({
        terminalId,
        cols,
        rows,
      });
    },
    [active, terminalId],
  );

  return (
    <TerminalPane
      ref={terminalRef}
      onInput={handleInput}
      onResize={handleResize}
      readOnly={readOnly}
      trackGlobalSize={trackGlobalSize}
    />
  );
}
