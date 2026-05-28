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
import { AlertCircle, LoaderCircle } from "lucide-react";
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
      errorMessage: null as string | null,
      isGeneratingMessage: false,
    },
    (set) => ({
      open: (payload: DiffReviewCommitDialogPayload) =>
        set({
          payload,
          subject: "",
          description: "",
          errorMessage: null,
          isGeneratingMessage: false,
        }),
      close: () =>
        set({
          payload: null,
          subject: "",
          description: "",
          errorMessage: null,
          isGeneratingMessage: false,
        }),
      setSubject: (subject: string) => set({ subject, errorMessage: null }),
      setDescription: (description: string) =>
        set({ description, errorMessage: null }),
      setErrorMessage: (errorMessage: string | null) => set({ errorMessage }),
      setIsGeneratingMessage: (isGeneratingMessage: boolean) =>
        set({ isGeneratingMessage }),
    }),
  ),
);

export function DiffReviewCommitDialog() {
  const payload = useDiffReviewCommitDialogStore((s) => s.payload);
  const subject = useDiffReviewCommitDialogStore((s) => s.subject);
  const description = useDiffReviewCommitDialogStore((s) => s.description);
  const errorMessage = useDiffReviewCommitDialogStore((s) => s.errorMessage);
  const isGeneratingMessage = useDiffReviewCommitDialogStore(
    (s) => s.isGeneratingMessage,
  );
  const close = useDiffReviewCommitDialogStore((s) => s.close);
  const setSubject = useDiffReviewCommitDialogStore((s) => s.setSubject);
  const setDescription = useDiffReviewCommitDialogStore(
    (s) => s.setDescription,
  );
  const setErrorMessage = useDiffReviewCommitDialogStore(
    (s) => s.setErrorMessage,
  );
  const setIsGeneratingMessage = useDiffReviewCommitDialogStore(
    (s) => s.setIsGeneratingMessage,
  );

  const queryClient = useQueryClient();

  const generateMessageMutation = useMutation({
    mutationFn: (vars: { projectPath: string; filePaths: string[] }) =>
      orpc.projects.generateCommitMessage.call({
        path: vars.projectPath,
        filePaths: vars.filePaths,
      }),
    onMutate: () => {
      setIsGeneratingMessage(true);
    },
    onSuccess: (data) => {
      const currentSubject = useDiffReviewCommitDialogStore.getState().subject;
      const currentDescription =
        useDiffReviewCommitDialogStore.getState().description;
      if (!currentSubject.trim() && data.subject) {
        setSubject(data.subject);
      }
      if (!currentDescription.trim() && data.description) {
        setDescription(data.description);
      }
    },
    onSettled: () => {
      setIsGeneratingMessage(false);
    },
    onError: (err: unknown) => {
      const message =
        err instanceof Error && err.message.trim()
          ? err.message
          : "Failed to generate commit message.";
      setErrorMessage(message);
    },
  });

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
      const message =
        err instanceof Error && err.message.trim()
          ? err.message
          : "Commit failed.";
      setErrorMessage(message);
    },
  });

  const open = Boolean(payload);
  const canCommit = (payload?.pathsToCommit.length ?? 0) > 0;
  const subjectTrimmed = subject.trim();
  const fieldsDisabled = commitMutation.isPending || isGeneratingMessage;

  const submitCommit = () => {
    if (
      !payload ||
      !canCommit ||
      commitMutation.isPending ||
      isGeneratingMessage
    ) {
      return;
    }

    setErrorMessage(null);

    if (!subjectTrimmed) {
      generateMessageMutation.mutate({
        projectPath: payload.projectPath,
        filePaths: payload.pathsToCommit,
      });
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
          if (!commitMutation.isPending && !isGeneratingMessage) {
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
              placeholder={
                isGeneratingMessage
                  ? "Generating commit message…"
                  : "Leave empty to autogenerate"
              }
              autoFocus
              disabled={fieldsDisabled}
              aria-required
            />
            <p className="text-xs text-muted-foreground">
              Leave the summary empty to autogenerate a message from the
              selected diff.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="commit-description">Description (optional)</Label>
            <Textarea
              id="commit-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={
                isGeneratingMessage
                  ? "Generating commit message…"
                  : "More detailed explanation…"
              }
              disabled={fieldsDisabled}
              rows={4}
            />
          </div>
          {errorMessage ? (
            <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-sans">
                {errorMessage}
              </pre>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => close()}
              disabled={commitMutation.isPending || isGeneratingMessage}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                !canCommit || commitMutation.isPending || isGeneratingMessage
              }
            >
              {commitMutation.isPending ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  Committing…
                </>
              ) : isGeneratingMessage ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  Generating…
                </>
              ) : subjectTrimmed ? (
                "Commit"
              ) : (
                "Generate message"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
