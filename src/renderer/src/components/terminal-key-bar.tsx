import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Textarea } from "@renderer/components/ui/textarea";
import { shouldAutoFocus } from "@renderer/lib/autofocus";
import { orpc } from "@renderer/orpc-client";
import { MessageSquareText, SendHorizontal } from "lucide-react";
import { useState } from "react";

const TERMINAL_KEYS = [
  { label: "Esc", data: "\x1b" },
  { label: "Tab", data: "\t" },
  { label: "Shift-Tab", data: "\x1b[Z" },
  { label: "Shift-Enter", data: "\\" },
  { label: "Up", data: "\x1b[A" },
  { label: "Down", data: "\x1b[B" },
  { label: "Left", data: "\x1b[D" },
  { label: "Right", data: "\x1b[C" },
  { label: "Ctrl-C", data: "\x03" },
] as const;

export function TerminalKeyBar({ terminalId }: { terminalId: string }) {
  const [inputOpen, setInputOpen] = useState(false);
  const [inputText, setInputText] = useState("");

  const send = (data: string) => {
    void orpc.terminals.writeToTerminal.call({ terminalId, data });
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
            event.preventDefault();
            setInputOpen(true);
          }}
        >
          <MessageSquareText className="size-4" />
        </Button>
        {TERMINAL_KEYS.map(({ label, data }) => (
          <Button
            key={label}
            type="button"
            variant="outline"
            size="sm"
            tabIndex={-1}
            className="min-w-10 shrink-0 font-mono text-xs"
            onPointerDown={(event) => {
              event.preventDefault();
              send(data);
            }}
          >
            {label}
          </Button>
        ))}
      </div>

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
