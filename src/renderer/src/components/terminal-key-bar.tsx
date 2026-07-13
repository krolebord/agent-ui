import { Button } from "@renderer/components/ui/button";
import { Textarea } from "@renderer/components/ui/textarea";
import { useTerminalAttachFiles } from "@renderer/hooks/use-terminal-attach-files";
import { shouldAutoFocus } from "@renderer/lib/autofocus";
import { orpc } from "@renderer/orpc-client";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CornerDownLeft,
  type LucideIcon,
  MessageSquareText,
  Paperclip,
  SendHorizontal,
  X,
} from "lucide-react";
import type React from "react";
import { useRef, useState } from "react";

// Codex's TUI speaks the Kitty keyboard protocol, where Shift+Enter is encoded
// as CSI 13 ; 2 u (13 = Enter keycode, 2 = shift modifier). Claude and plain
// shells instead treat a trailing backslash as a soft newline, so a bare "\\"
// is the right sequence for them.
const shiftEnterData = (sessionType: string | undefined): string =>
  sessionType === "codex-local-terminal" ? "\x1b[13;2u" : "\\";

type TerminalKey = {
  label: string;
  data: string;
  // When present, the key renders as an icon button; `label` is used as the
  // accessible name instead of visible text.
  icon?: LucideIcon;
};

const terminalKeys = (sessionType: string | undefined): TerminalKey[] => [
  { label: "Esc", data: "\x1b" },
  { label: "Ctrl-C", data: "\x03" },
  { label: "Tab", data: "\t" },
  {
    label: "New line",
    data: shiftEnterData(sessionType),
    icon: CornerDownLeft,
  },
  { label: "Shift-Tab", data: "\x1b[Z" },
  { label: "Up", data: "\x1b[A", icon: ArrowUp },
  { label: "Down", data: "\x1b[B", icon: ArrowDown },
  { label: "Left", data: "\x1b[D", icon: ArrowLeft },
  { label: "Right", data: "\x1b[C", icon: ArrowRight },
];

// Max distance (px) a pointer may travel between down and up before the
// gesture is treated as a scroll rather than a tap.
const TAP_MOVE_THRESHOLD = 10;

export function TerminalKeyBar({
  terminalId,
  sessionType,
}: {
  terminalId: string;
  sessionType?: string;
}) {
  const [inputOpen, setInputOpen] = useState(false);
  const [inputText, setInputText] = useState("");
  const { openFilePicker, fileInput } = useTerminalAttachFiles(terminalId);
  // Tracks the pointer-down position and pending action so we can tell taps
  // apart from scrolls of the key bar.
  const pending = useRef<{
    id: number;
    x: number;
    y: number;
    action: () => void;
  } | null>(null);

  const send = (data: string) => {
    void orpc.terminals.writeToTerminal.call({ terminalId, data });
  };

  // preventDefault on pointerdown keeps focus (and the mobile keyboard) on the
  // terminal instead of moving it to the button. Capturing the pointer routes
  // the matching pointerup back to this element even if the finger drifts, and
  // we only run the action if it didn't move far enough to count as a scroll.
  const handlePointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
    action: () => void,
  ) => {
    event.preventDefault();
    pending.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      action,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    const start = pending.current;
    pending.current = null;
    if (!start || event.pointerId !== start.id) {
      return;
    }

    const movedX = Math.abs(event.clientX - start.x);
    const movedY = Math.abs(event.clientY - start.y);
    if (movedX <= TAP_MOVE_THRESHOLD && movedY <= TAP_MOVE_THRESHOLD) {
      start.action();
    }
  };

  const handlePointerCancel = () => {
    pending.current = null;
  };

  const submitInput = () => {
    if (!inputText) {
      return;
    }

    send(`${inputText}\r`);
    setInputText("");
    setInputOpen(false);
  };

  if (inputOpen) {
    return (
      <>
        <form
          className="flex shrink-0 items-end gap-1 border-t border-border/70 bg-background px-2 py-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            submitInput();
          }}
        >
          {/* Activated via pointer events, not onClick: this button occupies the
              same spot as the "open input" button, so the ghost click that the
              browser dispatches right after the opening tap would land here and
              immediately close the form again. Ghost clicks carry no pointerdown,
              so the pointer-tap pattern is immune. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            tabIndex={-1}
            className="min-w-10 shrink-0 px-2"
            aria-label="Close terminal input"
            title="Close terminal input"
            onPointerDown={(event) => {
              handlePointerDown(event, () => setInputOpen(false));
            }}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
          >
            <X className="size-4" />
          </Button>
          <Textarea
            autoFocus={shouldAutoFocus()}
            placeholder="Type a prompt..."
            value={inputText}
            onChange={(event) => {
              setInputText(event.target.value);
            }}
            rows={1}
            // Cap at 3 lines (24px line height + vertical padding), then scroll.
            className="max-h-[5.5rem] min-h-9 flex-1 resize-none overflow-y-auto py-1.5"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-w-10 shrink-0 px-2"
            aria-label="Attach file"
            title="Attach file"
            onClick={openFilePicker}
          >
            <Paperclip className="size-4" />
          </Button>
          <Button
            type="submit"
            size="sm"
            className="min-w-10 shrink-0 px-2"
            aria-label="Submit terminal input"
            title="Submit terminal input"
            disabled={!inputText}
          >
            <SendHorizontal className="size-4" />
          </Button>
        </form>

        {fileInput}
      </>
    );
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border/70 bg-background px-2 py-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          tabIndex={-1}
          className="min-w-10 shrink-0 touch-pan-x px-2"
          aria-label="Open terminal input"
          title="Open terminal input"
          onPointerDown={(event) => {
            handlePointerDown(event, () => setInputOpen(true));
          }}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        >
          <MessageSquareText className="size-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          tabIndex={-1}
          className="min-w-10 shrink-0 touch-pan-x px-2"
          aria-label="Attach file"
          title="Attach file"
          onPointerDown={(event) => {
            handlePointerDown(event, openFilePicker);
          }}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        >
          <Paperclip className="size-4" />
        </Button>
        {terminalKeys(sessionType).map(({ label, data, icon: Icon }) => (
          <Button
            key={label}
            type="button"
            variant="outline"
            size="sm"
            tabIndex={-1}
            className="min-w-10 shrink-0 touch-pan-x font-mono text-xs"
            aria-label={Icon ? label : undefined}
            title={Icon ? label : undefined}
            onPointerDown={(event) => {
              handlePointerDown(event, () => send(data));
            }}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
          >
            {Icon ? <Icon className="size-4" /> : label}
          </Button>
        ))}
      </div>

      {fileInput}
    </>
  );
}
