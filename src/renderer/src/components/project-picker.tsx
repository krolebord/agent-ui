import { useAppState } from "@renderer/components/sync-state-provider";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { cn } from "@renderer/lib/utils";
import {
  buildProjectTree,
  getProjectSelectionOriginPath,
  type ProjectSelection,
  type ProjectTreeNode,
  projectTreeNodeHoldsSelection,
  resolveProjectSelectionDisplay,
} from "@renderer/services/terminal-session-selectors";
import { Check, ChevronsUpDown, GitFork, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { ProjectFavicon } from "./project-favicon";

export type { ProjectSelection };

interface ProjectPickerProps {
  value: ProjectSelection;
  onChange: (value: ProjectSelection) => void;
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

  const nodes = useMemo(
    () =>
      buildProjectTree({
        projects,
        selectedPath: getProjectSelectionOriginPath(value),
      }),
    [projects, value],
  );

  const selected = resolveProjectSelectionDisplay(nodes, value);

  const select = (next: ProjectSelection) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <DropdownMenu modal open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Project"
          title={getProjectSelectionOriginPath(value) || undefined}
          disabled={disabled}
          className="h-8 w-full justify-start gap-1.5 px-2 font-normal"
        >
          {selected ? (
            <ProjectFavicon
              projectPath={selected.faviconPath}
              className="size-3.5"
            />
          ) : null}
          <span className="truncate">
            {selected?.label ?? "Select project"}
          </span>
          {selected?.detail ? (
            <>
              <span className="text-muted-foreground/60 shrink-0">/</span>
              <span
                className={cn(
                  "text-muted-foreground truncate",
                  value.kind === "new-worktree" && "italic",
                )}
              >
                {selected.detail}
              </span>
            </>
          ) : null}
          <ChevronsUpDown className="ml-auto size-3 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[min(320px,var(--radix-dropdown-menu-content-available-height,320px))] w-(--radix-dropdown-menu-trigger-width) overflow-y-auto"
      >
        {nodes.length === 0 ? (
          <div className="text-muted-foreground p-4 text-center text-xs">
            No projects yet.
          </div>
        ) : (
          nodes.map((node) => (
            <ProjectMenuEntry
              key={node.path}
              node={node}
              value={value}
              onSelect={select}
            />
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProjectMenuEntry({
  node,
  value,
  onSelect,
}: {
  node: ProjectTreeNode;
  value: ProjectSelection;
  onSelect: (value: ProjectSelection) => void;
}) {
  const isRootSelected = value.kind === "project" && value.path === node.path;
  const holdsSelection = projectTreeNodeHoldsSelection(node, value);

  const label = (
    <>
      <ProjectFavicon projectPath={node.path} className="size-3.5" />
      <span className="truncate">{node.label}</span>
      {node.hidden || node.unlisted ? (
        <span className="text-muted-foreground shrink-0 text-xs">
          {node.hidden ? "hidden" : "unlisted"}
        </span>
      ) : null}
    </>
  );

  if (!node.canCreateWorktree && node.worktrees.length === 0) {
    return (
      <DropdownMenuItem
        disabled={node.disabled}
        title={node.path}
        className="gap-1.5"
        onSelect={() => {
          onSelect({ kind: "project", path: node.path });
        }}
      >
        <SelectionCheck selected={isRootSelected} />
        {label}
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenuSub defaultOpen={holdsSelection && !isRootSelected}>
      <DropdownMenuSubTrigger
        disabled={node.disabled}
        title={node.path}
        className={cn("gap-1.5", holdsSelection && "bg-accent/50")}
        onClick={() => {
          onSelect({ kind: "project", path: node.path });
        }}
      >
        <SelectionCheck selected={holdsSelection} />
        {label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-52">
        <DropdownMenuItem
          className="gap-1.5"
          onSelect={() => {
            onSelect({ kind: "project", path: node.path });
          }}
        >
          <SelectionCheck selected={isRootSelected} />
          <span className="truncate">Default</span>
          {node.branch ? (
            <span className="text-muted-foreground ml-auto truncate text-xs">
              {node.branch}
            </span>
          ) : null}
        </DropdownMenuItem>

        {node.worktrees.length > 0 ? <DropdownMenuSeparator /> : null}
        {node.worktrees.map((worktree) => (
          <DropdownMenuItem
            key={worktree.path}
            disabled={worktree.disabled}
            title={worktree.path}
            className="gap-1.5"
            onSelect={() => {
              onSelect({ kind: "project", path: worktree.path });
            }}
          >
            <SelectionCheck
              selected={
                value.kind === "project" && value.path === worktree.path
              }
            />
            <GitFork className="text-muted-foreground size-3.5" />
            <span className="truncate">{worktree.label}</span>
          </DropdownMenuItem>
        ))}

        {node.canCreateWorktree ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="gap-1.5"
              onSelect={() => {
                onSelect({ kind: "new-worktree", originPath: node.path });
              }}
            >
              <SelectionCheck
                selected={
                  value.kind === "new-worktree" &&
                  value.originPath === node.path
                }
              />
              <Plus className="text-muted-foreground size-3.5" />
              <span className="truncate">New worktree</span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function SelectionCheck({ selected }: { selected: boolean }) {
  return (
    <Check
      className={cn("size-3 shrink-0", selected ? "opacity-100" : "opacity-0")}
    />
  );
}
