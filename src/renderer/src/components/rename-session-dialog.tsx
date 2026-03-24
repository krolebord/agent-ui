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
import { orpc } from "@renderer/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { Session } from "src/main/sessions/state";
import { create } from "zustand";
import { combine } from "zustand/middleware";

type RenamableSessionType = Session["type"];

export interface RenameSessionTarget {
  sessionId: string;
  type: RenamableSessionType;
  title: string;
}

export const useRenameSessionDialogStore = create(
  combine({ target: null as RenameSessionTarget | null }, (set) => ({
    open: (target: RenameSessionTarget) => set({ target }),
    close: () => set({ target: null }),
  })),
);

export function RenameSessionDialog() {
  const target = useRenameSessionDialogStore((x) => x.target);
  const close = useRenameSessionDialogStore((x) => x.close);

  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const renameSessionMutation = useMutation({
    mutationFn: async (target: RenameSessionTarget) => {
      switch (target.type) {
        case "claude-local-terminal":
          await orpc.sessions.localClaude.renameSession.call({
            sessionId: target.sessionId,
            title: target.title,
          });
          return;
        case "local-terminal":
          await orpc.sessions.localTerminal.renameSession.call({
            sessionId: target.sessionId,
            title: target.title,
          });
          return;
        case "codex-local-terminal":
          await orpc.sessions.codex.renameSession.call({
            sessionId: target.sessionId,
            title: target.title,
          });
          return;
        case "cursor-agent":
          await orpc.sessions.cursorAgent.renameSession.call({
            sessionId: target.sessionId,
            title: target.title,
          });
          return;
        case "ralph-loop":
          await orpc.sessions.ralphLoop.renameSession.call({
            sessionId: target.sessionId,
            title: target.title,
          });
          return;
        case "worktree-setup":
          await orpc.sessions.worktreeSetup.renameSession.call({
            sessionId: target.sessionId,
            title: target.title,
          });
          return;
      }
    },
    onSuccess: () => {
      close();
    },
    onError: () => {
      toast.error("Failed to rename session");
    },
  });

  useEffect(() => {
    setTitle(target?.title ?? "");
    setError(null);
  }, [target]);

  const closeDialog = () => {
    if (renameSessionMutation.isPending) {
      return;
    }
    close();
  };

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          closeDialog();
        }
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Rename session</DialogTitle>
          <DialogDescription>
            Update the title shown in the sidebar.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!target) {
              return;
            }

            const nextTitle = title.trim();
            if (!nextTitle) {
              setError("Session name cannot be empty");
              return;
            }

            renameSessionMutation.mutate({
              ...target,
              title: nextTitle,
            });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="rename-session-title">Session name</Label>
            <Input
              id="rename-session-title"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setError(null);
              }}
              autoFocus
              maxLength={120}
              disabled={renameSessionMutation.isPending}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closeDialog}
              disabled={renameSessionMutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={renameSessionMutation.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
