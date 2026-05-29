import { useAppState } from "@renderer/components/sync-state-provider";
import { Button } from "@renderer/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@renderer/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@renderer/components/ui/popover";
import { cn } from "@renderer/lib/utils";
import { ChevronsUpDown, FileText } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

export interface HandoffEntryDisplay {
  path: string;
  filename: string;
  title: string;
  preview: string;
  createdAt: number;
}

interface HandoffPickerProps {
  value: HandoffEntryDisplay | null;
  onChange: (next: HandoffEntryDisplay | null) => void;
  disabled?: boolean;
}

export function buildHandoffPromptTemplate(handoffPath: string): string {
  return `Read the handoff at ${handoffPath}. We will continue the work described there. Treat it as context to verify against the code, not facts to trust blindly — read any files it references before acting.`;
}

export function useHandoffSelection(params: {
  initialPrompt: string;
  setInitialPrompt: (value: string) => void;
  selectedHandoff: HandoffEntryDisplay | null;
  setSelectedHandoff: (value: HandoffEntryDisplay | null) => void;
}) {
  const {
    initialPrompt,
    setInitialPrompt,
    selectedHandoff,
    setSelectedHandoff,
  } = params;
  return useCallback(
    (next: HandoffEntryDisplay | null) => {
      if (next) {
        setInitialPrompt(buildHandoffPromptTemplate(next.path));
        setSelectedHandoff(next);
        return;
      }
      if (
        selectedHandoff &&
        initialPrompt === buildHandoffPromptTemplate(selectedHandoff.path)
      ) {
        setInitialPrompt("");
      }
      setSelectedHandoff(null);
    },
    [initialPrompt, selectedHandoff, setInitialPrompt, setSelectedHandoff],
  );
}

function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

export function HandoffPicker({
  value,
  onChange,
  disabled,
}: HandoffPickerProps) {
  const [open, setOpen] = useState(false);

  const handoffs = useAppState((state) => state.handoffs);
  const entries = useMemo(
    () => Object.values(handoffs).sort((a, b) => b.createdAt - a.createdAt),
    [handoffs],
  );

  const handleSelect = (entry: HandoffEntryDisplay) => {
    onChange(entry);
    setOpen(false);
  };

  const handleClearSelection = () => {
    onChange(null);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            <FileText className="size-4 shrink-0 opacity-70" />
            {value ? (
              <span className="truncate">{value.title}</span>
            ) : (
              <span className="text-muted-foreground">No handoff selected</span>
            )}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[var(--radix-popover-trigger-width)] min-w-[360px] p-0"
      >
        {entries.length === 0 ? (
          <div className="text-muted-foreground p-6 text-center text-sm">
            No handoffs yet. Ask any session to run the{" "}
            <code className="bg-muted rounded px-1 py-0.5 text-xs">
              agent-ui-handoff
            </code>{" "}
            skill to create one.
          </div>
        ) : (
          <Command shouldFilter>
            <CommandInput placeholder="Search handoffs..." />
            <CommandList className="max-h-[420px]">
              <CommandEmpty>No matches.</CommandEmpty>
              {value && (
                <CommandItem
                  value="__clear-handoff-selection"
                  onSelect={handleClearSelection}
                  className="text-muted-foreground px-2 py-1.5 text-xs"
                >
                  Clear selection
                </CommandItem>
              )}
              {entries.map((entry) => (
                <CommandItem
                  key={entry.path}
                  value={`${entry.path}\n${entry.title}`}
                  onSelect={() => handleSelect(entry)}
                  className={cn(
                    "flex-col items-start gap-1 px-2 py-2",
                    value?.path === entry.path && "bg-accent/40",
                  )}
                >
                  <span className="flex w-full items-baseline justify-between gap-2">
                    <span className="line-clamp-1 text-sm font-medium">
                      {entry.title}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {formatRelativeTime(entry.createdAt)}
                    </span>
                  </span>
                  {entry.preview && (
                    <span className="text-muted-foreground line-clamp-3 text-xs whitespace-pre-wrap">
                      {entry.preview}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}
