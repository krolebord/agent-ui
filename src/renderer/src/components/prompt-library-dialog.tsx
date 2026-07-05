import { useConfirmDialogStore } from "@renderer/components/confirm-dialog";
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
import { Textarea } from "@renderer/components/ui/textarea";
import { shouldAutoFocus } from "@renderer/lib/autofocus";
import { orpc } from "@renderer/orpc-client";
import type { PromptLibraryEntry } from "@shared/prompt-library";
import { useMutation } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { combine } from "zustand/middleware";

type EditorTarget =
  | { mode: "create" }
  | { mode: "edit"; entry: PromptLibraryEntry };

export const usePromptLibraryDialogStore = create(
  combine({ isOpen: false }, (set) => ({
    open: () => {
      set({ isOpen: true });
    },
    close: () => {
      set({ isOpen: false });
    },
  })),
);

function sortPrompts(entries: PromptLibraryEntry[]): PromptLibraryEntry[] {
  return [...entries].sort((left, right) => right.updatedAt - left.updatedAt);
}

export function PromptLibraryDialog() {
  const { isOpen, close } = usePromptLibraryDialogStore();
  const prompts = useAppState((state) => state.appSettings.promptLibrary);
  const entries = useMemo(() => sortPrompts(prompts), [prompts]);

  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);

  const createMutation = useMutation(
    orpc.appSettings.createPromptLibraryEntry.mutationOptions({
      onSuccess: () => {
        setEditorTarget(null);
        toast.success("Prompt added");
      },
      onError: () => {
        toast.error("Failed to add prompt");
      },
    }),
  );

  const updateMutation = useMutation(
    orpc.appSettings.updatePromptLibraryEntry.mutationOptions({
      onSuccess: () => {
        setEditorTarget(null);
        toast.success("Prompt updated");
      },
      onError: () => {
        toast.error("Failed to update prompt");
      },
    }),
  );

  const deleteMutation = useMutation(
    orpc.appSettings.deletePromptLibraryEntry.mutationOptions({
      onSuccess: () => {
        toast.success("Prompt deleted");
      },
      onError: () => {
        toast.error("Failed to delete prompt");
      },
    }),
  );

  const isSaving = createMutation.isPending || updateMutation.isPending;

  useEffect(() => {
    if (!isOpen) {
      setEditorTarget(null);
      setName("");
      setBody("");
      setNameError(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!editorTarget) {
      setName("");
      setBody("");
      setNameError(null);
      return;
    }

    if (editorTarget.mode === "edit") {
      setName(editorTarget.entry.name);
      setBody(editorTarget.entry.body);
      setNameError(null);
    } else {
      setName("");
      setBody("");
      setNameError(null);
    }
  }, [editorTarget]);

  const closeDialog = () => {
    if (isSaving) {
      return;
    }
    close();
  };

  const handleSave = () => {
    const nextName = name.trim();
    if (!nextName) {
      setNameError("Name is required");
      return;
    }

    if (editorTarget?.mode === "edit") {
      updateMutation.mutate({
        id: editorTarget.entry.id,
        name: nextName,
        body,
      });
      return;
    }

    createMutation.mutate({
      name: nextName,
      body,
    });
  };

  const handleDelete = (entry: PromptLibraryEntry) => {
    useConfirmDialogStore.getState().confirm({
      title: "Delete prompt",
      description: `Delete "${entry.name}"? This cannot be undone.`,
      confirmLabel: "Delete",
      onConfirm: async () => {
        await deleteMutation.mutateAsync({ id: entry.id });
        if (
          editorTarget?.mode === "edit" &&
          editorTarget.entry.id === entry.id
        ) {
          setEditorTarget(null);
        }
      },
    });
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          closeDialog();
        }
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Prompt library</DialogTitle>
          <DialogDescription>
            Save reusable prompts and copy them into any session.
          </DialogDescription>
        </DialogHeader>

        {editorTarget ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              handleSave();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="prompt-library-name">Name</Label>
              <Input
                id="prompt-library-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameError(null);
                }}
                autoFocus={shouldAutoFocus()}
                maxLength={120}
                disabled={isSaving}
              />
              {nameError ? (
                <p className="text-sm text-destructive">{nameError}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="prompt-library-body">Prompt</Label>
              <Textarea
                id="prompt-library-body"
                value={body}
                onChange={(event) => {
                  setBody(event.target.value);
                }}
                rows={8}
                disabled={isSaving}
              />
            </div>
            <DialogFooter className="gap-2 sm:justify-between">
              <Button
                type="button"
                variant="outline"
                disabled={isSaving}
                onClick={() => {
                  setEditorTarget(null);
                }}
              >
                Back
              </Button>
              <Button type="submit" disabled={isSaving}>
                {editorTarget.mode === "edit" ? "Save changes" : "Add prompt"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="flex min-h-0 flex-col gap-3">
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setEditorTarget({ mode: "create" });
                }}
              >
                <Plus className="mr-1.5 size-3.5" />
                Add prompt
              </Button>
            </div>
            <div className="max-h-[min(420px,50vh)] overflow-y-auto rounded-md border border-border/60">
              {entries.length === 0 ? (
                <div className="text-muted-foreground p-6 text-center text-sm">
                  No prompts yet.
                </div>
              ) : (
                <ul className="divide-y divide-border/40">
                  {entries.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex items-start gap-2 px-3 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">
                          {entry.name}
                        </div>
                        {entry.body ? (
                          <div className="text-muted-foreground mt-1 line-clamp-2 text-xs whitespace-pre-wrap">
                            {entry.body}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="size-8 px-0"
                          aria-label={`Edit ${entry.name}`}
                          onClick={() => {
                            setEditorTarget({ mode: "edit", entry });
                          }}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="size-8 px-0 text-destructive hover:text-destructive"
                          aria-label={`Delete ${entry.name}`}
                          disabled={deleteMutation.isPending}
                          onClick={() => {
                            handleDelete(entry);
                          }}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function PromptLibrarySettingsItem() {
  const openManageDialog = usePromptLibraryDialogStore((state) => state.open);
  const promptCount = useAppState(
    (state) => state.appSettings.promptLibrary.length,
  );

  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">Prompt library</div>
        <div className="text-xs text-muted-foreground">
          {promptCount === 0
            ? "No saved prompts yet"
            : `${promptCount} saved prompt${promptCount === 1 ? "" : "s"}`}
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={openManageDialog}
      >
        Manage
      </Button>
    </div>
  );
}
