import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { useMutation } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { create } from "zustand";
import { combine } from "zustand/middleware";

export interface ConfirmDialogOptions {
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => Promise<void> | void;
}

export const useConfirmDialogStore = create(
  combine(
    {
      options: null as ConfirmDialogOptions | null,
    },
    (set) => ({
      confirm: (options: ConfirmDialogOptions) => {
        set({ options });
      },
      close: () => {
        set({ options: null });
      },
    }),
  ),
);

export function ConfirmDialog() {
  const { options, close } = useConfirmDialogStore();
  const mutation = useMutation({
    mutationFn: async () => {
      await options?.onConfirm();
    },
    onSuccess: () => {
      close();
    },
  });

  return (
    <Dialog
      open={options !== null}
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) {
          close();
        }
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{options?.title}</DialogTitle>
          <DialogDescription>{options?.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={close}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            autoFocus
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending && (
              <LoaderCircle className="size-4 animate-spin" />
            )}
            {options?.confirmLabel ?? "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
