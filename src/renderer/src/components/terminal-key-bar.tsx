import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Textarea } from "@renderer/components/ui/textarea";
import { useTerminalFileUpload } from "@renderer/hooks/use-terminal-file-upload";
import { shouldAutoFocus } from "@renderer/lib/autofocus";
import { orpc } from "@renderer/orpc-client";
import { MessageSquareText, Paperclip, SendHorizontal } from "lucide-react";
import type React from "react";
import { useRef, useState } from "react";

// Codex's TUI speaks the Kitty keyboard protocol, where Shift+Enter is encoded
// as CSI 13 ; 2 u (13 = Enter keycode, 2 = shift modifier). Claude and plain
// shells instead treat a trailing backslash as a soft newline, so a bare "\\"
// is the right sequence for them.
const shiftEnterData = (sessionType: string | undefined): string =>
  sessionType === "codex-local-terminal" ? "\x1b[13;2u" : "\\";

const terminalKeys = (sessionType: string | undefined) =>
  [
    { label: "Esc", data: "\x1b" },
    { label: "Tab", data: "\t" },
    { label: "Shift-Tab", data: "\x1b[Z" },
    { label: "Shift-Enter", data: shiftEnterData(sessionType) },
    { label: "Up", data: "\x1b[A" },
    { label: "Down", data: "\x1b[B" },
    { label: "Left", data: "\x1b[D" },
    { label: "Right", data: "\x1b[C" },
    { label: "Ctrl-C", data: "\x03" },
  ] as const;

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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadFile = useTerminalFileUpload(terminalId);
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

  // Uploads each picked file and pastes the resulting host paths into the
  // terminal (space-separated), the same tokens a drag-drop would produce.
  const handleFilesSelected = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) {
      return;
    }

    const paths = (
      await Promise.all(Array.from(fileList).map((file) => uploadFile(file)))
    ).filter((path): path is string => path != null);

    if (paths.length > 0) {
      send(`${paths.join(" ")} `);
    }
  };

  const submitInput = () => {
    if (!inputText) {
      return;
    }

    send(`${inputText}\r`);
    setInputText("");
    setInputOpen(false);
  };

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border/70 bg-background px-2 py-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          tabIndex={-1}
          className="min-w-10 shrink-0 px-2"
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
          className="min-w-10 shrink-0 px-2"
          aria-label="Attach file"
          title="Attach file"
          onPointerDown={(event) => {
            handlePointerDown(event, () => fileInputRef.current?.click());
          }}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        >
          <Paperclip className="size-4" />
        </Button>
        {terminalKeys(sessionType).map(({ label, data }) => (
          <Button
            key={label}
            type="button"
            variant="outline"
            size="sm"
            tabIndex={-1}
            className="min-w-10 shrink-0 font-mono text-xs"
            onPointerDown={(event) => {
              handlePointerDown(event, () => send(data));
            }}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
          >
            {label}
          </Button>
        ))}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          void handleFilesSelected(event.target.files);
          // Reset so selecting the same file again re-triggers change.
          event.target.value = "";
        }}
      />

      <Dialog open={inputOpen} onOpenChange={setInputOpen}>
        <DialogContent className="top-auto bottom-[1rem] max-w-[calc(100%-1rem)] gap-3 sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Terminal input</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              submitInput();
            }}
          >
            <Textarea
              autoFocus={shouldAutoFocus()}
              placeholder="Type a prompt..."
              value={inputText}
              onChange={(event) => {
                setInputText(event.target.value);
              }}
              rows={6}
              className="max-h-[45dvh] resize-none"
            />
            <DialogFooter>
              <Button type="submit" disabled={!inputText}>
                <SendHorizontal className="size-4" />
                Submit
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
