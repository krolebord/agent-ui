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
import { createClickableErrorToastResult } from "@renderer/lib/clickable-error-toast";
import { orpc } from "@renderer/orpc-client";
import { useQueryClient } from "@tanstack/react-query";
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

  const open = Boolean(payload);
  const canCommit = (payload?.pathsToCommit.length ?? 0) > 0;

  const submitCommit = () => {
    if (!payload || !canCommit) {
      return;
    }

    const subjectTrimmed = subject.trim();
    const descriptionTrimmed = description.trim();
    const { projectPath, pathsToCommit, onCommitted } = payload;

    close();

    const commitPromise = orpc.projects.commitSelectedChanges
      .call({
        path: projectPath,
        filePaths: pathsToCommit,
        subject: subjectTrimmed || undefined,
        description: descriptionTrimmed || undefined,
      })
      .then(() => {
        onCommitted?.();
        void queryClient.invalidateQueries({
          queryKey: orpc.projects.getUncommittedDiff.queryKey({
            input: { path: projectPath },
          }),
        });
      });

    toast.promise(commitPromise, {
      loading: "Creating commit…",
      success: "Commit created",
      error: (err) =>
        createClickableErrorToastResult(err, "Commit failed", "Commit failed."),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          close();
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
              placeholder="Leave empty to autogenerate"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Leave the summary empty to autogenerate a message from the
              selected diff when you commit.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="commit-description">Description (optional)</Label>
            <Textarea
              id="commit-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="More detailed explanation…"
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close()}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canCommit}>
              Commit
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
