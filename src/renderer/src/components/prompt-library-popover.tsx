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
import { useCopyToClipboard } from "@renderer/hooks/use-copy-to-clipboard";
import { cn } from "@renderer/lib/utils";
import type { PromptLibraryEntry } from "@shared/prompt-library";
import { ClipboardList, Copy } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { usePromptLibraryDialogStore } from "./prompt-library-dialog";

interface PromptLibraryPopoverProps {
  trigger?: ReactNode;
  triggerClassName?: string;
  align?: "start" | "center" | "end";
}

function sortPrompts(entries: PromptLibraryEntry[]): PromptLibraryEntry[] {
  return [...entries].sort((left, right) => right.updatedAt - left.updatedAt);
}

export function PromptLibraryPopover({
  trigger,
  triggerClassName,
  align = "end",
}: PromptLibraryPopoverProps) {
  const [open, setOpen] = useState(false);
  const { copy } = useCopyToClipboard();
  const openManageDialog = usePromptLibraryDialogStore((state) => state.open);

  const prompts = useAppState((state) => state.appSettings.promptLibrary);
  const entries = useMemo(() => sortPrompts(prompts), [prompts]);

  const handleCopy = async (entry: PromptLibraryEntry) => {
    await copy(entry.body);
    toast.success(`Copied "${entry.name}"`);
    setOpen(false);
  };

  const handleManage = () => {
    setOpen(false);
    openManageDialog();
  };

  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn("size-8 shrink-0 px-0", triggerClassName)}
            aria-label="Prompt library"
            title="Prompt library"
          >
            <ClipboardList className="size-3.5 text-muted-foreground" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align={align}
        sideOffset={6}
        className="w-[min(420px,var(--radix-popover-content-available-width,420px))] overflow-hidden p-0"
        onWheel={(event) => {
          event.stopPropagation();
        }}
        onTouchMove={(event) => {
          event.stopPropagation();
        }}
      >
        {entries.length === 0 ? (
          <div className="space-y-4 p-6 text-center text-sm">
            <p className="text-muted-foreground">
              No prompts yet. Add reusable prompts you can copy into any
              session.
            </p>
            <Button type="button" size="sm" onClick={handleManage}>
              Manage prompts
            </Button>
          </div>
        ) : (
          <Command
            shouldFilter
            className="max-h-[min(420px,var(--radix-popover-content-available-height,420px))]"
          >
            <CommandInput placeholder="Search prompts..." />
            <CommandList className="max-h-[min(320px,var(--radix-popover-content-available-height,320px))] min-h-0 overscroll-contain">
              <CommandEmpty>No matches.</CommandEmpty>
              {entries.map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={`${entry.name}\n${entry.body}`}
                  onSelect={() => {
                    void handleCopy(entry);
                  }}
                  className="flex-col items-start gap-1 px-2 py-2"
                >
                  <span className="flex w-full items-center justify-between gap-2">
                    <span className="line-clamp-1 text-sm font-medium">
                      {entry.name}
                    </span>
                    <Copy className="size-3.5 shrink-0 text-muted-foreground" />
                  </span>
                  {entry.body ? (
                    <span className="text-muted-foreground line-clamp-2 text-xs whitespace-pre-wrap">
                      {entry.body}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandList>
            <div className="border-t border-border/40 p-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 w-full justify-start text-xs text-muted-foreground"
                onClick={handleManage}
              >
                Manage prompts...
              </Button>
            </div>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function SidebarPromptLibraryButton() {
  return (
    <PromptLibraryPopover
      align="start"
      trigger={
        <Button
          type="button"
          variant="flat"
          className="h-full w-9 shrink-0 px-0"
          aria-label="Prompt library"
          title="Prompt library"
        >
          <ClipboardList className="size-3.5" />
        </Button>
      }
    />
  );
}
