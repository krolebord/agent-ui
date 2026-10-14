import { Textarea } from "@renderer/components/ui/textarea";
import { isCoarsePointer } from "@renderer/lib/pointer";
import { cn } from "@renderer/lib/utils";
import type { ReactNode } from "react";

interface SessionPromptBoxProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  placeholder: string;
  autoFocus?: boolean;
  handoffControl?: ReactNode;
  modeControl?: ReactNode;
}

export function SessionPromptBox({
  id,
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
  autoFocus,
  handoffControl,
  modeControl,
}: SessionPromptBoxProps) {
  return (
    <div className="border-input focus-within:border-ring focus-within:ring-ring/50 rounded-md border transition-[color,box-shadow] focus-within:ring-[3px]">
      <Textarea
        id={id}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !isCoarsePointer()) {
            event.preventDefault();
            onSubmit();
          } else if (event.key === "Escape" && onCancel) {
            event.preventDefault();
            onCancel();
          }
        }}
        aria-label={placeholder}
        className={cn(
          "min-h-22 md:min-h-19 border-0 shadow-none focus-visible:border-0 focus-visible:ring-0",
          (handoffControl || modeControl) && "rounded-b-none",
        )}
      />
      {handoffControl || modeControl ? (
        <div className="border-input bg-secondary/40 flex items-center gap-1.5 rounded-b-md border-t px-1.5 py-1">
          {handoffControl}
          {modeControl ? (
            <div className="ml-auto min-w-0">{modeControl}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
