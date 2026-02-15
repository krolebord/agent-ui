import { cn } from "@renderer/lib/utils";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type ForwardedRef,
} from "react";
import "@xterm/xterm/css/xterm.css";

export interface TerminalPaneHandle {
  write: (chunk: string) => void;
  clear: () => void;
  focus: () => void;
  getSize: () => { cols: number; rows: number };
}

interface TerminalPaneProps {
  className?: string;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

function TerminalPaneComponent(
  { className, onInput, onResize }: TerminalPaneProps,
  ref: ForwardedRef<TerminalPaneHandle>,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);

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
  }));

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "JetBrains Mono, Menlo, Consolas, monospace",
      fontSize: 13,
      theme: {
        background: "#0c1219",
        foreground: "#d5e4ff",
      },
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(container);
    terminalRef.current = terminal;

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

      return true;
    });

    fitAddon.fit();

    const fitAndNotify = () => {
      if (!container.clientWidth || !container.clientHeight) {
        return;
      }

      fitAddon.fit();
      onResizeRef.current(terminal.cols, terminal.rows);
    };

    const onDataDisposable = terminal.onData((data) => {
      onInputRef.current(data);
    });

    const onResizeDisposable = terminal.onResize(({ cols, rows }) => {
      onResizeRef.current(cols, rows);
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAndNotify();
    });
    resizeObserver.observe(container);

    const onWindowResize = () => {
      fitAndNotify();
    };

    window.addEventListener("resize", onWindowResize);
    window.requestAnimationFrame(fitAndNotify);

    return () => {
      onDataDisposable.dispose();
      onResizeDisposable.dispose();
      resizeObserver.disconnect();
      window.removeEventListener("resize", onWindowResize);
      terminal.dispose();
      terminalRef.current = null;
    };
  }, []);

  return <div ref={containerRef} className={cn("h-full w-full", className)} />;
}

export const TerminalPane = forwardRef(TerminalPaneComponent);
