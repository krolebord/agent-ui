import { useAppState } from "@renderer/components/sync-state-provider";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { orpc } from "@renderer/orpc-client";
import { getProjectDisplayName } from "@renderer/services/terminal-session-selectors";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle, FolderSearch, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { combine } from "zustand/middleware";

type WorktreeCreationData = Awaited<
  ReturnType<(typeof orpc.projects.getWorktreeCreationData)["call"]>
>;

export const useProjectWorktreeDialogStore = create(
  combine(
    {
      openProjectPath: null as string | null,
    },
    (set) => ({
      setOpenProjectPath: (openProjectPath: string | null) => {
        set({ openProjectPath });
      },
    }),
  ),
);

function sanitizeWorktreePathSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .replace(/^-+|-+$/g, "");

  return sanitized || "worktree";
}

function joinParentPath(parentPath: string, leafName: string): string {
  if (!parentPath) {
    return leafName;
  }

  const separator = parentPath.includes("\\") ? "\\" : "/";
  const normalizedParent =
    parentPath.endsWith("/") || parentPath.endsWith("\\")
      ? parentPath.slice(0, -1)
      : parentPath;

  return `${normalizedParent}${separator}${leafName}`;
}

function buildSuggestedDestinationPath(
  parentPath: string,
  sourceProjectName: string,
  branchName: string,
): string {
  return joinParentPath(
    parentPath,
    `${sourceProjectName}-${sanitizeWorktreePathSegment(branchName)}`,
  );
}

export function ProjectWorktreeDialog() {
  const openProjectPath = useProjectWorktreeDialogStore(
    (s) => s.openProjectPath,
  );
  const setOpenProjectPath = useProjectWorktreeDialogStore(
    (s) => s.setOpenProjectPath,
  );

  const project = useAppState((state) => {
    if (!openProjectPath) {
      return null;
    }

    return state.projects.find((item) => item.path === openProjectPath) ?? null;
  });

  const [creationData, setCreationData] = useState<WorktreeCreationData | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fromBranch, setFromBranch] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [alias, setAlias] = useState("");
  const [parentPath, setParentPath] = useState("");
  const [destinationPath, setDestinationPath] = useState("");
  const [destinationWasEdited, setDestinationWasEdited] = useState(false);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!openProjectPath) {
        throw new Error("No source project selected.");
      }

      return orpc.projects.createWorktreeProject.call({
        sourcePath: openProjectPath,
        fromBranch,
        newBranch,
        destinationPath,
        alias: alias || undefined,
      });
    },
    onSuccess: () => {
      setOpenProjectPath(null);
    },
    onError: (error) => {
      if (error instanceof Error && error.message.trim()) {
        setErrorMessage(error.message);
        return;
      }

      setErrorMessage("Failed to create worktree project.");
    },
  });

  useEffect(() => {
    if (!openProjectPath) {
      setCreationData(null);
      setErrorMessage(null);
      setFromBranch("");
      setNewBranch("");
      setAlias("");
      setParentPath("");
      setDestinationPath("");
      setDestinationWasEdited(false);
      return;
    }

    let cancelled = false;

    setIsLoading(true);
    setErrorMessage(null);

    void orpc.projects.getWorktreeCreationData
      .call({ path: openProjectPath })
      .then((data) => {
        if (cancelled) {
          return;
        }

        setCreationData(data);
        setFromBranch(data.currentBranch);
        setNewBranch("");
        setAlias("");
        setParentPath(data.suggestedDestinationParentPath);
        setDestinationPath(
          buildSuggestedDestinationPath(
            data.suggestedDestinationParentPath,
            data.sourceProjectName,
            "",
          ),
        );
        setDestinationWasEdited(false);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        if (error instanceof Error && error.message.trim()) {
          setErrorMessage(error.message);
          return;
        }

        setErrorMessage("Failed to load worktree options.");
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [openProjectPath]);

  useEffect(() => {
    if (!creationData || destinationWasEdited) {
      return;
    }

    setDestinationPath(
      buildSuggestedDestinationPath(
        parentPath || creationData.suggestedDestinationParentPath,
        creationData.sourceProjectName,
        newBranch,
      ),
    );
  }, [creationData, destinationWasEdited, newBranch, parentPath]);

  if (!openProjectPath) {
    return null;
  }

  const projectName = project
    ? getProjectDisplayName(project)
    : (creationData?.sourceProjectName ?? openProjectPath);
  const isPending = isLoading || createMutation.isPending;

  const closeDialog = () => {
    if (createMutation.isPending) {
      return;
    }

    setOpenProjectPath(null);
  };

  const handlePickParentFolder = async () => {
    const selectedPath = await orpc.fs.selectFolderWithOptions.call({
      title: "Select Worktree Parent Folder",
      defaultPath: parentPath || creationData?.suggestedDestinationParentPath,
    });
    if (!selectedPath || !creationData) {
      return;
    }

    setParentPath(selectedPath);
    setDestinationWasEdited(false);
    setDestinationPath(
      buildSuggestedDestinationPath(
        selectedPath,
        creationData.sourceProjectName,
        newBranch,
      ),
    );
  };

  const handleSubmit = () => {
    setErrorMessage(null);

    if (!fromBranch.trim()) {
      setErrorMessage("Source branch is required.");
      return;
    }
    if (!newBranch.trim()) {
      setErrorMessage("New branch is required.");
      return;
    }
    if (!destinationPath.trim()) {
      setErrorMessage("Destination path is required.");
      return;
    }

    createMutation.mutate();
  };

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          closeDialog();
        }
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Create worktree project</DialogTitle>
          <DialogDescription>
            Create a Git worktree from{" "}
            <span className="text-foreground">{projectName}</span>
            <br />
            <span className="text-xs text-muted-foreground">
              {openProjectPath}
            </span>
          </DialogDescription>
        </DialogHeader>

        {isLoading && !creationData ? (
          <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            <span>Loading worktree options...</span>
          </div>
        ) : null}

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmit();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="worktree-from-branch">From branch</Label>
            <Select
              value={fromBranch}
              onValueChange={(value) => {
                setFromBranch(value);
              }}
              disabled={!creationData || isPending}
            >
              <SelectTrigger id="worktree-from-branch">
                <SelectValue placeholder="Select a branch" />
              </SelectTrigger>
              <SelectContent>
                {creationData?.localBranches.map((branch) => (
                  <SelectItem key={branch} value={branch}>
                    {branch}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="worktree-new-branch">New branch</Label>
            <Input
              id="worktree-new-branch"
              autoFocus
              placeholder="feature/new-worktree"
              value={newBranch}
              onChange={(event) => {
                setNewBranch(event.target.value);
              }}
              disabled={!creationData || isPending}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="worktree-alias">Project alias (optional)</Label>
            <Input
              id="worktree-alias"
              placeholder="Frontend Worktree"
              value={alias}
              onChange={(event) => {
                setAlias(event.target.value);
              }}
              disabled={isPending}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="worktree-destination-path">
                Destination path
              </Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void handlePickParentFolder();
                }}
                disabled={!creationData || isPending}
              >
                <FolderSearch className="size-3.5" />
                Choose parent folder
              </Button>
            </div>
            <Input
              id="worktree-destination-path"
              placeholder={creationData?.suggestedDestinationPath}
              value={destinationPath}
              onChange={(event) => {
                setDestinationWasEdited(true);
                setDestinationPath(event.target.value);
              }}
              disabled={!creationData || isPending}
            />
          </div>

          {errorMessage ? (
            <div className="flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
              <AlertCircle className="size-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closeDialog}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!creationData || isPending}>
              {createMutation.isPending ? "Creating..." : "Create worktree"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
