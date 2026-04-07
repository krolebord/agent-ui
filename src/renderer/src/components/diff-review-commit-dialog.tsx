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
import { Textarea } from "@renderer/components/ui/textarea";
import { orpc } from "@renderer/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { create } from "zustand";
import { combine } from "zustand/middleware";

export type DiffReviewCommitDialogPayload = {
  projectPath: string;
  pathsToCommit: string[];
  selectedFileCount: number;
  onCommitted?: () => void;
};

export const useDiffReviewCommitDialogStore = create(
  combine(
    {
      payload: null as DiffReviewCommitDialogPayload | null,
      subject: "",
      description: "",
    },
    (set) => ({
      open: (payload: DiffReviewCommitDialogPayload) =>
        set({
          payload,
          subject: "",
          description: "",
        }),
      close: () =>
        set({
          payload: null,
          subject: "",
          description: "",
        }),
      setSubject: (subject: string) => set({ subject }),
      setDescription: (description: string) => set({ description }),
    }),
  ),
);

export function DiffReviewCommitDialog() {
  const payload = useDiffReviewCommitDialogStore((s) => s.payload);
  const subject = useDiffReviewCommitDialogStore((s) => s.subject);
  const description = useDiffReviewCommitDialogStore((s) => s.description);
  const close = useDiffReviewCommitDialogStore((s) => s.close);
  const setSubject = useDiffReviewCommitDialogStore((s) => s.setSubject);
  const setDescription = useDiffReviewCommitDialogStore(
    (s) => s.setDescription,
  );

  const queryClient = useQueryClient();

  const commitMutation = useMutation({
    mutationFn: (vars: {
      projectPath: string;
      filePaths: string[];
      subject: string;
      description: string | undefined;
      onCommitted?: () => void;
    }) =>
      orpc.projects.commitSelectedChanges.call({
        path: vars.projectPath,
        filePaths: vars.filePaths,
        subject: vars.subject,
        description: vars.description,
      }),
    onSuccess: (_data, vars) => {
      vars.onCommitted?.();
      void queryClient.invalidateQueries({
        queryKey: orpc.projects.getUncommittedDiff.queryKey({
          input: { path: vars.projectPath },
        }),
      });
      toast.success("Commit created");
      close();
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Commit failed";
      toast.error(message);
    },
  });

  const open = Boolean(payload);
  const canCommit = (payload?.pathsToCommit.length ?? 0) > 0;
  const subjectTrimmed = subject.trim();

  const submitCommit = () => {
    if (!payload || !subjectTrimmed || !canCommit || commitMutation.isPending) {
      return;
    }
    const descriptionTrimmed = description.trim();
    commitMutation.mutate({
      projectPath: payload.projectPath,
      filePaths: payload.pathsToCommit,
      subject: subjectTrimmed,
      description: descriptionTrimmed ? descriptionTrimmed : undefined,
      onCommitted: payload.onCommitted,
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          if (!commitMutation.isPending) {
            close();
          }
        }
      }}
    >
      <DialogContent
        overlayClassName="z-60"
        className="z-60 sm:max-w-md"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Commit changes</DialogTitle>
          <DialogDescription>
            {payload && canCommit
              ? `Commit ${payload.selectedFileCount} selected file${payload.selectedFileCount === 1 ? "" : "s"} with the message below.`
              : "Include at least one file in the commit (use the checkboxes)."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submitCommit();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="commit-subject">Commit message</Label>
            <Input
              id="commit-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Summary"
              autoFocus
              disabled={commitMutation.isPending}
              aria-required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="commit-description">Description (optional)</Label>
            <Textarea
              id="commit-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="More detailed explanation…"
              disabled={commitMutation.isPending}
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => close()}
              disabled={commitMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                !canCommit || !subjectTrimmed || commitMutation.isPending
              }
            >
              {commitMutation.isPending ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  Committing…
                </>
              ) : (
                "Commit"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
