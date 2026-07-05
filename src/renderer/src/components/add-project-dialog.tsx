import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import { Label } from "@renderer/components/ui/label";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { shouldAutoFocus } from "@renderer/lib/autofocus";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  CornerLeftUp,
  Folder,
  Home,
  LoaderCircle,
  Plus,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { combine } from "zustand/middleware";

const DEFAULT_PROJECT_PATH = "~/";

type DirectoryListItem =
  | {
      type: "parent";
      name: "..";
      fullPath: string;
    }
  | {
      type: "directory";
      name: string;
      fullPath: string;
    };

export const useAddProjectDialogStore = create(
  combine(
    {
      isOpen: false,
    },
    (set) => ({
      open: () => set({ isOpen: true }),
      close: () => set({ isOpen: false }),
    }),
  ),
);

function hasTrailingPathSeparator(pathValue: string) {
  const trimmed = pathValue.trim();
  return trimmed === "~" || /[\\/]$/.test(trimmed);
}

function getLeafPathSegment(pathValue: string) {
  const trimmed = pathValue.trim();
  const lastSeparatorIndex = Math.max(
    trimmed.lastIndexOf("/"),
    trimmed.lastIndexOf("\\"),
  );
  return trimmed.slice(lastSeparatorIndex + 1);
}

function appendPathSeparator(pathValue: string) {
  return /[\\/]$/.test(pathValue) ? pathValue : `${pathValue}/`;
}

function getParentBrowsePath(pathValue: string) {
  const trimmed = pathValue.replace(/[\\/]+$/, "");
  if (!trimmed || trimmed === "/" || /^[a-zA-Z]:$/.test(trimmed)) {
    return null;
  }

  const lastSeparatorIndex = Math.max(
    trimmed.lastIndexOf("/"),
    trimmed.lastIndexOf("\\"),
  );
  if (lastSeparatorIndex <= 0) {
    return "/";
  }

  return appendPathSeparator(trimmed.slice(0, lastSeparatorIndex));
}

function formatError(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Failed to browse folder.";
}

export function AddProjectDialog() {
  const { isOpen, close } = useAddProjectDialogStore();
  const [pathInput, setPathInput] = useState(DEFAULT_PROJECT_PATH);
  const [highlightedPath, setHighlightedPath] = useState<string | null>(null);
  const entryIdPrefix = useId();
  const trimmedPath = pathInput.trim();

  useEffect(() => {
    if (isOpen) {
      setPathInput(DEFAULT_PROJECT_PATH);
      setHighlightedPath(null);
    }
  }, [isOpen]);

  const browseQuery = useQuery({
    ...orpc.fs.browseDirectories.queryOptions({
      input: { partialPath: trimmedPath || DEFAULT_PROJECT_PATH },
    }),
    enabled: isOpen && trimmedPath.length > 0,
    retry: false,
  });

  const browseResult = browseQuery.data;
  const entries = useMemo(() => browseResult?.entries ?? [], [browseResult]);
  const parentPath = browseResult
    ? getParentBrowsePath(browseResult.parentPath)
    : null;
  const hasSearchQuery =
    !hasTrailingPathSeparator(pathInput) &&
    getLeafPathSegment(pathInput).length > 0;
  const directoryItems = useMemo<DirectoryListItem[]>(() => {
    const folders = entries.map((entry) => ({
      type: "directory" as const,
      name: entry.name,
      fullPath: entry.fullPath,
    }));

    if (!parentPath || hasSearchQuery) {
      return folders;
    }

    return [
      {
        type: "parent",
        name: "..",
        fullPath: parentPath,
      },
      ...folders,
    ];
  }, [entries, hasSearchQuery, parentPath]);
  const exactEntry = useMemo(() => {
    if (!browseResult || hasTrailingPathSeparator(pathInput)) {
      return null;
    }
    const leaf = getLeafPathSegment(pathInput);
    return entries.find((entry) => entry.name === leaf) ?? null;
  }, [browseResult, entries, pathInput]);
  const highlightedItem =
    directoryItems.find((item) => item.fullPath === highlightedPath) ?? null;
  const highlightedIndex = highlightedItem
    ? directoryItems.findIndex(
        (item) => item.fullPath === highlightedItem.fullPath,
      )
    : -1;
  const activeEntryPath = highlightedItem?.fullPath ?? exactEntry?.fullPath;
  const activeEntryId =
    highlightedIndex >= 0 ? `${entryIdPrefix}-${highlightedIndex}` : undefined;
  const selectedPath = hasTrailingPathSeparator(pathInput)
    ? browseResult?.parentPath
    : exactEntry?.fullPath;

  useEffect(() => {
    if (
      highlightedPath &&
      !directoryItems.some((item) => item.fullPath === highlightedPath)
    ) {
      setHighlightedPath(null);
    }
  }, [directoryItems, highlightedPath]);

  useEffect(() => {
    if (!activeEntryId) {
      return;
    }

    document.getElementById(activeEntryId)?.scrollIntoView({
      block: "nearest",
    });
  }, [activeEntryId]);

  const addProjectMutation = useMutation({
    mutationFn: async (projectPath: string) => {
      await orpc.projects.addProject.call({ path: projectPath });
    },
    onSuccess: () => {
      close();
    },
    onError: (error) => {
      toast.error(
        error instanceof Error && error.message.trim()
          ? error.message
          : "Failed to add project.",
      );
    },
  });

  const browseTo = (targetPath: string) => {
    setHighlightedPath(null);
    setPathInput(appendPathSeparator(targetPath));
  };

  const highlightNextEntry = (direction: "up" | "down") => {
    if (!directoryItems.length) {
      return;
    }

    setHighlightedPath((currentPath) => {
      const currentIndex = currentPath
        ? directoryItems.findIndex((item) => item.fullPath === currentPath)
        : -1;
      const nextIndex =
        direction === "down"
          ? currentIndex < 0
            ? 0
            : (currentIndex + 1) % directoryItems.length
          : currentIndex < 0
            ? directoryItems.length - 1
            : (currentIndex - 1 + directoryItems.length) %
              directoryItems.length;

      return directoryItems[nextIndex]?.fullPath ?? null;
    });
  };

  const handleAddProject = () => {
    if (!selectedPath || addProjectMutation.isPending) {
      return;
    }
    addProjectMutation.mutate(selectedPath);
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>
            Browse folders on the machine running Agent UI.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="add-project-path">Folder path</Label>
          <div className="flex gap-2">
            <Input
              id="add-project-path"
              autoFocus={shouldAutoFocus()}
              value={pathInput}
              onChange={(event) => {
                setHighlightedPath(null);
                setPathInput(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  highlightNextEntry("down");
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  highlightNextEntry("up");
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  if (highlightedItem) {
                    browseTo(highlightedItem.fullPath);
                  } else {
                    handleAddProject();
                  }
                }
              }}
              placeholder="~/Projects/my-app"
              disabled={addProjectMutation.isPending}
              aria-activedescendant={activeEntryId}
              aria-controls="add-project-directory-list"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => {
                setHighlightedPath(null);
                setPathInput(DEFAULT_PROJECT_PATH);
              }}
              disabled={addProjectMutation.isPending}
              aria-label="Go to home folder"
              title="Home"
            >
              <Home className="size-4" />
            </Button>
          </div>
        </div>

        <div className="rounded-md border border-border/70">
          <div className="flex h-9 items-center gap-2 border-b border-border/70 px-3">
            <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {browseResult?.parentPath ?? trimmedPath}
            </span>
            {browseQuery.isFetching ? (
              <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
            ) : null}
          </div>
          <ScrollArea className="h-64">
            {browseQuery.isError ? (
              <div className="flex h-full items-start gap-2 p-3 text-sm text-destructive">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span>{formatError(browseQuery.error)}</span>
              </div>
            ) : browseQuery.isLoading ? (
              <div className="flex h-full items-center justify-center">
                <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : directoryItems.length ? (
              <div
                id="add-project-directory-list"
                role="listbox"
                className="py-1"
              >
                {directoryItems.map((item, index) => (
                  <button
                    key={`${item.type}:${item.fullPath}`}
                    id={`${entryIdPrefix}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={activeEntryPath === item.fullPath}
                    className={cn(
                      "flex min-h-9 w-full items-center gap-2 px-3 text-left text-sm transition hover:bg-accent/70",
                      activeEntryPath === item.fullPath &&
                        "bg-accent text-accent-foreground",
                    )}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setHighlightedPath(item.fullPath)}
                    onClick={() => browseTo(item.fullPath)}
                    disabled={addProjectMutation.isPending}
                    aria-label={
                      item.type === "parent"
                        ? "Go to parent folder"
                        : `Open ${item.name}`
                    }
                  >
                    {item.type === "parent" ? (
                      <CornerLeftUp className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <Folder className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="p-3 text-sm text-muted-foreground">
                No matching folders.
              </div>
            )}
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleAddProject}
            disabled={!selectedPath || addProjectMutation.isPending}
          >
            {addProjectMutation.isPending ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Add project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
