import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Label } from "@renderer/components/ui/label";
import { orpc } from "@renderer/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { combine } from "zustand/middleware";

interface WorktreeDeleteDialogTarget {
  path: string;
  displayName: string;
  gitBranch?: string;
}

type DeleteWorktreeProjectResult = {
  warning?: string;
  requiresForce?: boolean;
  errorMessage?: string;
};

function getErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return null;
}

export function normalizeWorktreeDeleteCheckboxValues(values: {
  deleteFolder: boolean;
  deleteBranch: boolean;
  forceDeleteFolder: boolean;
}): {
  deleteFolder: boolean;
  deleteBranch: boolean;
  forceDeleteFolder: boolean;
} {
  if (!values.deleteFolder) {
    return {
      ...values,
      deleteBranch: false,
      forceDeleteFolder: false,
    };
  }

  if (values.deleteBranch) {
    return {
      ...values,
      deleteFolder: true,
    };
  }

  return values;
}

export function shouldShowForceDeleteOption(input: {
  deleteFolder: boolean;
  forceDeleteFolder: boolean;
  requiresForce: boolean;
}): boolean {
  return (
    input.deleteFolder &&
    (input.forceDeleteFolder || input.requiresForce === true)
  );
}

export const useWorktreeDeleteDialogStore = create(
  combine({ target: null as WorktreeDeleteDialogTarget | null }, (set) => ({
    open: (target: WorktreeDeleteDialogTarget) => {
      set({ target });
    },
    close: () => {
      set({ target: null });
    },
  })),
);

export function WorktreeDeleteDialog() {
  const { target, close } = useWorktreeDeleteDialogStore();
  const targetPath = target?.path ?? null;
  const [checkboxValues, setCheckboxValues] = useState({
    deleteFolder: true,
    deleteBranch: false,
    forceDeleteFolder: false,
  });
  const [requiresForce, setRequiresForce] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!target) {
        return {};
      }

      return await orpc.projects.deleteWorktreeProject.call({
        path: target.path,
        deleteFolder: checkboxValues.deleteFolder,
        deleteBranch: checkboxValues.deleteBranch,
        forceDeleteFolder: checkboxValues.forceDeleteFolder,
      });
    },
    onSuccess: (result: DeleteWorktreeProjectResult) => {
      if (result.requiresForce) {
        setRequiresForce(true);
        return;
      }

      if (result.warning) {
        toast.warning(result.warning);
      }
      close();
    },
  });

  useEffect(() => {
    if (targetPath === null) {
      setCheckboxValues({
        deleteFolder: true,
        deleteBranch: false,
        forceDeleteFolder: false,
      });
      setRequiresForce(false);
      deleteMutation.reset();
      return;
    }

    setCheckboxValues({
      deleteFolder: true,
      deleteBranch: false,
      forceDeleteFolder: false,
    });
    setRequiresForce(false);
    deleteMutation.reset();
  }, [targetPath, deleteMutation.reset]);

  const errorMessage =
    getErrorMessage(deleteMutation.error) ??
    (requiresForce
      ? "Project folder has modified or untracked files. Enable force delete to remove the worktree and discard those changes."
      : null);
  const showForceDeleteOption = shouldShowForceDeleteOption({
    deleteFolder: checkboxValues.deleteFolder,
    forceDeleteFolder: checkboxValues.forceDeleteFolder,
    requiresForce,
  });

  const setNextCheckboxValues = (
    updater: (current: typeof checkboxValues) => typeof checkboxValues,
  ) => {
    setCheckboxValues((current) =>
      normalizeWorktreeDeleteCheckboxValues(updater(current)),
    );
    deleteMutation.reset();
    setRequiresForce(false);
  };

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !deleteMutation.isPending) {
          close();
        }
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete worktree project</DialogTitle>
          <DialogDescription>
            {target
              ? `Delete "${target.displayName}" from Agent UI. You can also remove the worktree folder and its local branch.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        {errorMessage ? (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {errorMessage}
          </p>
        ) : null}
        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-lg border border-border/60 px-3 py-2">
            <Checkbox
              id="worktree-delete-folder"
              checked={checkboxValues.deleteFolder}
              disabled={deleteMutation.isPending}
              onCheckedChange={(checked) => {
                setNextCheckboxValues((current) => ({
                  ...current,
                  deleteFolder: checked === true,
                }));
              }}
            />
            <div className="space-y-1">
              <Label htmlFor="worktree-delete-folder" className="leading-5">
                Also delete project folder
              </Label>
              <p className="text-sm text-muted-foreground">
                Remove the Git worktree from disk using Git. Checked by default
                for worktree projects.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 rounded-lg border border-border/60 px-3 py-2">
            <Checkbox
              id="worktree-delete-branch"
              checked={checkboxValues.deleteBranch}
              disabled={deleteMutation.isPending || !target?.gitBranch}
              onCheckedChange={(checked) => {
                setNextCheckboxValues((current) => ({
                  ...current,
                  deleteBranch: checked === true,
                }));
              }}
            />
            <div className="space-y-1">
              <Label htmlFor="worktree-delete-branch" className="leading-5">
                Also delete project branch
              </Label>
              <p className="text-sm text-muted-foreground">
                {target?.gitBranch
                  ? `Delete the local branch "${target.gitBranch}" after the worktree folder is removed.`
                  : "This worktree does not currently have a resolved local branch."}
              </p>
            </div>
          </div>

          {showForceDeleteOption ? (
            <div className="flex items-start gap-3 rounded-lg border border-border/60 px-3 py-2">
              <Checkbox
                id="worktree-force-delete-folder"
                checked={checkboxValues.forceDeleteFolder}
                disabled={deleteMutation.isPending}
                onCheckedChange={(checked) => {
                  setNextCheckboxValues((current) => ({
                    ...current,
                    forceDeleteFolder: checked === true,
                  }));
                }}
              />
              <div className="space-y-1">
                <Label
                  htmlFor="worktree-force-delete-folder"
                  className="leading-5"
                >
                  Force delete project folder
                </Label>
                <p className="text-sm text-muted-foreground">
                  Discard modified or untracked files in this worktree and
                  remove it with Git.
                </p>
              </div>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={close}
            disabled={deleteMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            autoFocus
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : null}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
