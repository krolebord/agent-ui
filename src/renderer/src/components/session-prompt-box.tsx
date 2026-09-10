import { Textarea } from "@renderer/components/ui/textarea";
import { isCoarsePointer } from "@renderer/lib/pointer";
import type { ReactNode } from "react";

interface SessionPromptBoxProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
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
          }
        }}
        aria-label={placeholder}
        className="min-h-22 md:min-h-19 rounded-b-none border-0 shadow-none focus-visible:border-0 focus-visible:ring-0"
      />
      <div className="border-input bg-secondary/40 flex items-center gap-1.5 rounded-b-md border-t px-1.5 py-1">
        {handoffControl}
        {modeControl ? (
          <div className="ml-auto min-w-0">{modeControl}</div>
        ) : null}
      </div>
    </div>
  );
}
