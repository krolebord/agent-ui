import { useTerminalSizeStore } from "@renderer/hooks/use-terminal-size";
import { attachTouchScroll } from "@renderer/lib/terminal-touch-scroll";
import { cn } from "@renderer/lib/utils";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useEffect, useImperativeHandle, useRef } from "react";
import "@xterm/xterm/css/xterm.css";

const PTY_RESIZE_DEBOUNCE_MS = 75;

const isMacPlatform =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");

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
  /**
   * Called when the user pastes a file. Should persist the file and return
   * an absolute file path to paste into the terminal, or null to ignore the
   * paste.
   */
  onPasteFile?: (file: File) => Promise<string | null>;
  readOnly?: boolean;
  trackGlobalSize?: boolean;
  ref: React.RefObject<TerminalPaneHandle | null>;
}

// atob yields Latin-1 code units, so reinterpret the bytes as UTF-8.
function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

// Routes OSC 52 clipboard writes (e.g. Claude Code's own copy) to the client
// clipboard. Payload is "<selection>;<data>"; "<data>" is base64 or "?" (a read
// query we don't answer).
function handleOsc52(payload: string): boolean {
  const separator = payload.indexOf(";");
  if (separator === -1) {
    return true;
  }

  const data = payload.slice(separator + 1);
  if (data === "" || data === "?") {
    return true;
  }

  try {
    const text = decodeBase64Utf8(data);
    void navigator.clipboard?.writeText(text).catch(() => {});
  } catch {}
  return true;
}

function getPastedFile(clipboardData: DataTransfer | null): File | null {
  if (!clipboardData) {
    return null;
  }

  // If the clipboard also carries plain text (e.g. copied spreadsheet
  // cells or a file path), let the normal text paste win.
  if (clipboardData.getData("text/plain")) {
    return null;
  }

  for (const item of clipboardData.items) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) {
        return file;
      }
    }
  }

  return null;
}

export function TerminalPane({
  className,
  onInput,
  onResize,
  onPasteFile,
  readOnly = false,
  trackGlobalSize = true,
  ref,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<() => void>(() => {});
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const onPasteFileRef = useRef(onPasteFile);
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

  useEffect(() => {
    onPasteFileRef.current = onPasteFile;
  }, [onPasteFile]);

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
      // Required for terminal.parser.registerOscHandler below.
      allowProposedApi: true,
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
    const detachTouchScroll = attachTouchScroll(terminal, container);

    const onOsc52Disposable = terminal.parser.registerOscHandler(
      52,
      handleOsc52,
    );

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

      // Copy/paste keyboard shortcuts for the browser client.
      // On macOS the primary modifier is Cmd; on Windows/Linux it is Ctrl.
      if (event.type === "keydown") {
        const key = event.key.toLowerCase();
        const primaryModifier = isMacPlatform ? event.metaKey : event.ctrlKey;

        // Copy the current selection.
        //   macOS:        Cmd+C
        //   Windows/Linux: Ctrl+Shift+C, or Ctrl+C when text is selected.
        // Plain Ctrl+C with no selection falls through so it still sends
        // SIGINT to the process.
        if (key === "c" && primaryModifier) {
          const selection = terminal.getSelection();
          const wantsCopy =
            isMacPlatform || event.shiftKey || selection.length > 0;
          if (wantsCopy && selection.length > 0) {
            void navigator.clipboard.writeText(selection).catch(() => {});
            terminal.clearSelection();
            return false;
          }
        }

        // Paste from the clipboard.
        //   macOS:        Cmd+V
        //   Windows/Linux: Ctrl+V or Ctrl+Shift+V
        // Returning false lets the browser dispatch its native paste event,
        // which the existing text and image paste handlers consume (so image
        // paste keeps working too).
        if (key === "v" && primaryModifier) {
          return false;
        }
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

    // Capture-phase so this runs before xterm's own paste handler, which
    // only understands text. Files are persisted host-side (they can't
    // travel through the PTY stream) and their file path is pasted instead.
    const onPaste = (event: ClipboardEvent) => {
      const pasteFile = onPasteFileRef.current;
      if (!pasteFile || terminal.options.disableStdin) {
        return;
      }

      const file = getPastedFile(event.clipboardData);
      if (!file) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        const filePath = await pasteFile(file);
        if (filePath && terminalRef.current === terminal) {
          terminal.paste(filePath);
        }
      })();
    };
    container.addEventListener("paste", onPaste, true);

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
      detachTouchScroll();
      container.removeEventListener("paste", onPaste, true);
      // Blur while onData is still attached so DECSET 1004 focus-out reaches the PTY.
      terminal.blur();
      onDataDisposable.dispose();
      onResizeDisposable.dispose();
      onOsc52Disposable.dispose();
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

  return (
    <div
      ref={containerRef}
      className={cn("h-full w-full touch-none", className)}
    />
  );
}
