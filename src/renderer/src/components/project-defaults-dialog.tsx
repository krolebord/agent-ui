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
import { Label } from "@renderer/components/ui/label";
import { Textarea } from "@renderer/components/ui/textarea";
import { orpc } from "@renderer/orpc-client";
import { getProjectDisplayName } from "@renderer/services/terminal-session-selectors";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { combine } from "zustand/middleware";

export const useProjectDefaultsDialogStore = create(
  combine(
    {
      openProjectCwd: null as string | null,
    },
    (set) => ({
      setOpenProjectCwd: (openProjectCwd: string | null) => {
        set({ openProjectCwd });
      },
    }),
  ),
);

export function ProjectDefaultsDialog() {
  const openProjectCwd = useProjectDefaultsDialogStore((s) => s.openProjectCwd);
  const setOpenProjectCwd = useProjectDefaultsDialogStore(
    (s) => s.setOpenProjectCwd,
  );

  const project = useAppState((state) => {
    if (!openProjectCwd) {
      return null;
    }
    return state.projects.find((item) => item.path === openProjectCwd) ?? null;
  });

  useEffect(() => {
    if (openProjectCwd && project?.interactionDisabled) {
      setOpenProjectCwd(null);
    }
  }, [openProjectCwd, project?.interactionDisabled, setOpenProjectCwd]);

  const [worktreeSetupCommands, setWorktreeSetupCommands] = useState("");

  const saveMutation = useMutation(
    orpc.projects.setProjectDefaults.mutationOptions({
      onSuccess: () => {
        setOpenProjectCwd(null);
      },
    }),
  );

  useEffect(() => {
    if (!project) {
      return;
    }
    setWorktreeSetupCommands(project.worktreeSetupCommands ?? "");
  }, [project]);

  if (!openProjectCwd || !project) {
    return null;
  }

  const projectPath = project.path;
  const projectName = getProjectDisplayName(project);

  const closeDialog = () => {
    if (saveMutation.isPending) {
      return;
    }
    setOpenProjectCwd(null);
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
          <DialogTitle>Project settings</DialogTitle>
          <DialogDescription>
            Configure project-specific options for{" "}
            <span className="text-foreground">{projectName}</span>
            <br />
            <span className="text-xs text-muted-foreground">{projectPath}</span>
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            saveMutation.mutate({
              path: projectPath,
              worktreeSetupCommands: worktreeSetupCommands || undefined,
            });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="project-worktree-setup-commands">
              Worktree setup commands
            </Label>
            <Textarea
              id="project-worktree-setup-commands"
              placeholder={"pnpm install\ncp .env.example .env"}
              value={worktreeSetupCommands}
              onChange={(event) => {
                setWorktreeSetupCommands(event.target.value);
              }}
              rows={6}
            />
            <p className="text-xs text-muted-foreground">
              Commands run sequentially in the new worktree root. A failed
              command stops the remaining commands.{" "}
              <code className="select-all">$PROJECT_ROOT</code> and{" "}
              <code className="select-all">$WORKTREE_ROOT</code> are available
              as env variables.
            </p>
          </div>

          {saveMutation.error ? (
            <div className="flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
              <AlertCircle className="size-4 shrink-0" />
              <span>{saveMutation.error.message}</span>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closeDialog}
              disabled={saveMutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
