import { useTerminalSizeStore } from "@renderer/hooks/use-terminal-size";
import { cn } from "@renderer/lib/utils";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useEffect, useImperativeHandle, useRef } from "react";
import "@xterm/xterm/css/xterm.css";

const PTY_RESIZE_DEBOUNCE_MS = 75;

export interface TerminalPaneHandle {
  write: (chunk: string) => void;
  clear: () => void;
  focus: () => void;
  autofit: () => void;
  getSize: () => { cols: number; rows: number };
}

interface TerminalPaneProps {
  className?: string;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  readOnly?: boolean;
  trackGlobalSize?: boolean;
  ref: React.RefObject<TerminalPaneHandle | null>;
}

export function TerminalPane({
  className,
  onInput,
  onResize,
  readOnly = false,
  trackGlobalSize = true,
  ref,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<() => void>(() => {});
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const lastReportedSizeRef = useRef<{ cols: number; rows: number } | null>(
    null,
  );
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    onInputRef.current = onInput;
  }, [onInput]);

  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  useImperativeHandle(ref, () => ({
    write: (chunk: string) => {
      terminalRef.current?.write(chunk);
    },
    clear: () => {
      terminalRef.current?.clear();
      terminalRef.current?.reset();
    },
    focus: () => {
      terminalRef.current?.focus();
    },
    getSize: () => ({
      cols: terminalRef.current?.cols ?? 80,
      rows: terminalRef.current?.rows ?? 24,
    }),
    autofit: () => {
      fitRef.current();
    },
  }));

  // biome-ignore lint/correctness/useExhaustiveDependencies: readOnly is handled by the dedicated effect below; this effect initializes the terminal once
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      disableStdin: readOnly,
      fontFamily: "JetBrains Mono, Menlo, Consolas, monospace",
      fontSize: 13,
      theme: {
        background: "#0c1219",
        foreground: "#d5e4ff",
      },
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(
      new WebLinksAddon((_event, url) => {
        window.open(url, "_blank");
      }),
    );
    terminal.open(container);
    terminalRef.current = terminal;

    const flushResize = () => {
      const pending = pendingResizeRef.current;
      if (!pending) {
        return;
      }

      pendingResizeRef.current = null;
      const lastReported = lastReportedSizeRef.current;
      if (
        lastReported &&
        lastReported.cols === pending.cols &&
        lastReported.rows === pending.rows
      ) {
        return;
      }

      lastReportedSizeRef.current = pending;
      onResizeRef.current(pending.cols, pending.rows);
    };

    const scheduleResize = (cols: number, rows: number) => {
      pendingResizeRef.current = { cols, rows };
      if (resizeTimeoutRef.current != null) {
        window.clearTimeout(resizeTimeoutRef.current);
      }

      resizeTimeoutRef.current = window.setTimeout(() => {
        resizeTimeoutRef.current = null;
        flushResize();
      }, PTY_RESIZE_DEBOUNCE_MS);
    };

    terminal.attachCustomKeyEventHandler((event) => {
      if (
        event.type === "keydown" &&
        event.key === "Enter" &&
        event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        onInputRef.current("\\");
        return false;
      }

      // Let app-level Cmd/Ctrl shortcuts pass through to the document
      // so @tanstack/hotkeys can handle them (xterm would otherwise
      // call stopPropagation and swallow the event).
      if (event.type === "keydown" && (event.metaKey || event.ctrlKey)) {
        const key = event.key.toLowerCase();
        if (key === "backspace" || key === "n" || key === "j") {
          return false;
        }
      }

      return true;
    });

    const setTerminalSize = useTerminalSizeStore.getState().setSize;
    const fitAndNotify = () => {
      if (!container.clientWidth || !container.clientHeight) {
        return;
      }

      fitAddon.fit();
      if (trackGlobalSize) {
        setTerminalSize(terminal.cols, terminal.rows);
      }
      scheduleResize(terminal.cols, terminal.rows);
    };
    fitRef.current = fitAndNotify;

    const onDataDisposable = terminal.onData((data) => {
      onInputRef.current(data);
    });

    const onResizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (trackGlobalSize) {
        setTerminalSize(cols, rows);
      }
      scheduleResize(cols, rows);
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAndNotify();
    });
    resizeObserver.observe(container);

    const onWindowResize = () => {
      fitAndNotify();
    };

    window.addEventListener("resize", onWindowResize);
    fitAndNotify();

    return () => {
      onDataDisposable.dispose();
      onResizeDisposable.dispose();
      resizeObserver.disconnect();
      window.removeEventListener("resize", onWindowResize);
      if (resizeTimeoutRef.current != null) {
        window.clearTimeout(resizeTimeoutRef.current);
        resizeTimeoutRef.current = null;
      }
      pendingResizeRef.current = null;
      lastReportedSizeRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = () => {};
    };
  }, [trackGlobalSize]);

  useEffect(() => {
    if (!terminalRef.current) {
      return;
    }
    terminalRef.current.options.disableStdin = readOnly;
  }, [readOnly]);

  return <div ref={containerRef} className={cn("h-full w-full", className)} />;
}
