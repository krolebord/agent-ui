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
import { Check, ChevronsUpDown, GitFork } from "lucide-react";
import { useMemo, useState } from "react";

interface ProjectPickerProps {
  value: string;
  onChange: (path: string) => void;
  disabled?: boolean;
  id?: string;
}

/**
 * Inline project switcher. The trigger is deliberately text-sized so it can sit
 * in a sentence next to a label; the selected path is expected to be shown by
 * the caller, so rows here stay one line each.
 */
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
          variant="ghost"
          role="combobox"
          aria-expanded={open}
          aria-label="Project"
          disabled={disabled}
          className="text-foreground -mr-1 h-6 max-w-full gap-1 px-1 font-normal"
        >
          <span className="truncate">
            {selected?.label ?? "Select project"}
          </span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-56 overflow-hidden p-0"
        onWheel={(event) => {
          event.stopPropagation();
        }}
        onTouchMove={(event) => {
          event.stopPropagation();
        }}
      >
        {options.length === 0 ? (
          <div className="text-muted-foreground p-4 text-center text-xs">
            No projects yet.
          </div>
        ) : (
          <Command shouldFilter={showSearch}>
            {showSearch && (
              <CommandInput placeholder="Search projects..." className="h-8" />
            )}
            <CommandList className="max-h-[min(320px,var(--radix-popover-content-available-height,320px))] min-h-0 overscroll-contain">
              <CommandEmpty className="py-3 text-center text-xs">
                No matches.
              </CommandEmpty>
              {options.map((option) => (
                <CommandItem
                  key={option.path}
                  value={`${option.path}\n${option.label}`}
                  disabled={option.disabled}
                  title={option.path}
                  onSelect={() => {
                    onChange(option.path);
                    setOpen(false);
                  }}
                  className="gap-1.5 px-2 py-1"
                >
                  <Check
                    className={cn(
                      "size-3 shrink-0",
                      option.path === value ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="truncate text-sm">{option.label}</span>
                  {option.isWorktree && (
                    <GitFork className="text-muted-foreground size-3 shrink-0" />
                  )}
                  {(option.hidden || option.unlisted) && (
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {option.hidden ? "hidden" : "unlisted"}
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
