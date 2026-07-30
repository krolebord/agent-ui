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
import { buildProjectPickerOptions } from "@renderer/services/terminal-session-selectors";
import { Check, ChevronsUpDown, Folder, GitFork } from "lucide-react";
import { useMemo, useState } from "react";

interface ProjectPickerProps {
  value: string;
  onChange: (path: string) => void;
  disabled?: boolean;
  id?: string;
}

export function ProjectPicker({
  value,
  onChange,
  disabled,
  id,
}: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const projects = useAppState((state) => state.projects);

  const options = useMemo(
    () => buildProjectPickerOptions({ projects, selectedPath: value }),
    [projects, value],
  );

  const selected = options.find((option) => option.path === value) ?? null;
  const showSearch = options.length > 7;

  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="h-auto w-full justify-between gap-2 py-1.5 font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected?.isWorktree ? (
              <GitFork className="size-4 shrink-0 opacity-70" />
            ) : (
              <Folder className="size-4 shrink-0 opacity-70" />
            )}
            {selected ? (
              <span className="flex min-w-0 flex-col items-start">
                <span className="w-full truncate text-left text-sm">
                  {selected.label}
                </span>
                <span className="text-muted-foreground w-full truncate text-left text-xs">
                  {selected.path}
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground">No project selected</span>
            )}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[var(--radix-popover-trigger-width)] min-w-[320px] overflow-hidden p-0"
        onWheel={(event) => {
          event.stopPropagation();
        }}
        onTouchMove={(event) => {
          event.stopPropagation();
        }}
      >
        {options.length === 0 ? (
          <div className="text-muted-foreground p-6 text-center text-sm">
            No projects yet. Add one from the sidebar first.
          </div>
        ) : (
          <Command
            shouldFilter={showSearch}
            className="max-h-[min(420px,var(--radix-popover-content-available-height,420px))]"
          >
            {showSearch && <CommandInput placeholder="Search projects..." />}
            <CommandList className="max-h-[min(380px,var(--radix-popover-content-available-height,380px))] min-h-0 overscroll-contain">
              <CommandEmpty>No matches.</CommandEmpty>
              {options.map((option) => (
                <CommandItem
                  key={option.path}
                  value={`${option.path}\n${option.label}`}
                  disabled={option.disabled}
                  onSelect={() => {
                    onChange(option.path);
                    setOpen(false);
                  }}
                  className={cn(
                    "gap-2 px-2 py-1.5",
                    option.path === value && "bg-accent/40",
                  )}
                >
                  <Check
                    className={cn(
                      "size-4 shrink-0",
                      option.path === value ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm">{option.label}</span>
                      {option.isWorktree && (
                        <GitFork className="text-muted-foreground size-3 shrink-0" />
                      )}
                      {option.hidden && (
                        <span className="text-muted-foreground text-xs">
                          hidden
                        </span>
                      )}
                      {option.unlisted && (
                        <span className="text-muted-foreground text-xs">
                          not in project list
                        </span>
                      )}
                    </span>
                    <span className="text-muted-foreground truncate text-xs">
                      {option.path}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}
