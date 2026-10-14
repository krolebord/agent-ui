import type { Session } from "@main/sessions/state";
import { cn } from "@renderer/lib/utils";
import { getProjectDisplayName } from "@renderer/services/terminal-session-selectors";
import type { PromptSchedule } from "@shared/scheduled-prompts";
import { Check, ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import { useAppState } from "./sync-state-provider";
import { Button } from "./ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export type PromptSourceSelection = Omit<
  Extract<PromptSchedule, { kind: "after-session" }>,
  "kind"
> & { title: string };

export function RunningSessionPicker({
  sessions,
  value,
  onChange,
  disabled,
  className,
}: {
  sessions: Session[];
  value: PromptSourceSelection | null;
  onChange: (source: PromptSourceSelection) => void;
  disabled: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const projects = useAppState((state) => state.projects);
  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id="scheduled-prompt-source"
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn("w-full justify-between font-normal", className)}
        >
          <span className="min-w-0 truncate">
            {value?.title ?? "Choose a running session"}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
        onWheel={(event) => event.stopPropagation()}
      >
        <Command>
          <CommandInput placeholder="Search running sessions..." />
          <CommandList>
            <CommandEmpty>
              {sessions.length
                ? "No matching running sessions."
                : "No other sessions are currently running."}
            </CommandEmpty>
            <CommandGroup>
              {sessions.map((session) => {
                const project = projects.find(
                  (entry) => entry.path === session.startupConfig.cwd,
                );
                const projectName = project
                  ? getProjectDisplayName(project)
                  : session.startupConfig.cwd;
                return (
                  <CommandItem
                    key={session.sessionId}
                    value={session.sessionId}
                    keywords={[
                      session.title,
                      projectName,
                      session.startupConfig.cwd,
                      project?.gitBranch ?? "",
                    ]}
                    onSelect={() => {
                      if (
                        !session.turn ||
                        session.status !== "running" ||
                        session.turn.status !== "running"
                      )
                        return;
                      onChange({
                        sourceSessionId: session.sessionId,
                        sourceTurnId: session.turn.id,
                        title: session.title,
                      });
                      setOpen(false);
                    }}
                    className="gap-2"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {session.title}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {projectName}
                        {project?.gitBranch ? ` · ${project.gitBranch}` : ""}
                      </span>
                    </span>
                    <span className="text-xs text-sky-400">Running</span>
                    {value?.sourceSessionId === session.sessionId &&
                    value.sourceTurnId === session.turn?.id ? (
                      <Check className="size-3.5 shrink-0" />
                    ) : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
