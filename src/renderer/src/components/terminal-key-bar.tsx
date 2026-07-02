import { Button } from "@renderer/components/ui/button";
import { orpc } from "@renderer/orpc-client";

const TERMINAL_KEYS = [
  { label: "Esc", data: "\x1b" },
  { label: "Tab", data: "\t" },
  { label: "Shift-Tab", data: "\x1b[Z" },
  { label: "Up", data: "\x1b[A" },
  { label: "Down", data: "\x1b[B" },
  { label: "Left", data: "\x1b[D" },
  { label: "Right", data: "\x1b[C" },
  { label: "Ctrl-C", data: "\x03" },
] as const;

export function TerminalKeyBar({ terminalId }: { terminalId: string }) {
  const send = (data: string) => {
    void orpc.terminals.writeToTerminal.call({ terminalId, data });
  };

  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border/70 bg-background px-2 py-1.5">
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
  );
}
