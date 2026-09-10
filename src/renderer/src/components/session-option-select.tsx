import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Kbd } from "@renderer/components/ui/kbd";
import { cn } from "@renderer/lib/utils";
import {
  formatForDisplay,
  type Hotkey,
  useHotkey,
} from "@tanstack/react-hotkeys";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

export type OptionTone = "neutral" | "notice" | "caution" | "danger";

export interface SessionOption<TValue extends string> {
  value: TValue;
  label: string;
  tone?: OptionTone;
}

export const optionPillClassName = "h-8 gap-1.5 px-2.5 text-[13px] font-normal";

const toneClassName: Record<OptionTone, string> = {
  neutral: "text-muted-foreground",
  notice: "text-foreground bg-secondary border border-border",
  caution: "text-amber-400 bg-amber-400/10 border border-amber-400/45",
  danger: "text-rose-300 bg-rose-500/12 border border-rose-500/55",
};

const NO_HOTKEY: Hotkey = "Shift+Tab";

interface SessionOptionSelectProps<TValue extends string> {
  value: TValue;
  onChange: (value: TValue) => void;
  options: SessionOption<TValue>[];
  ariaLabel: string;
  label?: string;
  icon?: ReactNode;
  cycleHotkey?: Hotkey;
  disabled?: boolean;
  className?: string;
}

export function SessionOptionSelect<TValue extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  label,
  icon,
  cycleHotkey,
  disabled,
  className,
}: SessionOptionSelectProps<TValue>) {
  const selected = options.find((option) => option.value === value);
  const tone = selected?.tone ?? "neutral";

  useHotkey(
    cycleHotkey ?? NO_HOTKEY,
    () => {
      const index = options.findIndex((option) => option.value === value);
      const next = options[(index + 1) % options.length];
      if (next) {
        onChange(next.value);
      }
    },
    { enabled: cycleHotkey !== undefined, ignoreInputs: false },
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            optionPillClassName,
            toneClassName[tone],
            "min-w-0",
            className,
          )}
        >
          {icon}
          {label ? (
            <span className="text-muted-foreground shrink-0">{label}</span>
          ) : null}
          <span className="truncate">{selected?.label ?? value}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-44">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            onChange(next as TValue);
          }}
        >
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {cycleHotkey ? (
          <>
            <DropdownMenuSeparator />
            <div className="text-muted-foreground flex items-center justify-between gap-2 px-2 py-1 text-xs">
              <span>Cycle</span>
              <Kbd>{formatForDisplay(cycleHotkey)}</Kbd>
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface SessionOptionToggleProps {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  label: string;
  description: string;
  icon: ReactNode;
}

export function SessionOptionToggle({
  pressed,
  onPressedChange,
  label,
  description,
  icon,
}: SessionOptionToggleProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-pressed={pressed}
      title={description}
      onClick={() => {
        onPressedChange(!pressed);
      }}
      className={cn(
        optionPillClassName,
        pressed
          ? "text-foreground bg-secondary border border-border"
          : "text-muted-foreground",
      )}
    >
      {icon}
      <span className={pressed ? undefined : "line-through decoration-1"}>
        {label}
      </span>
    </Button>
  );
}
