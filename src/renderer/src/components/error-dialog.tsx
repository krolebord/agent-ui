import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { AlertCircle } from "lucide-react";
import { create } from "zustand";
import { combine } from "zustand/middleware";

export interface ErrorDialogPayload {
  title: string;
  message: string;
}

export const useErrorDialogStore = create(
  combine(
    {
      payload: null as ErrorDialogPayload | null,
    },
    (set) => ({
      open: (payload: ErrorDialogPayload) => set({ payload }),
      close: () => set({ payload: null }),
    }),
  ),
);

export function ErrorDialog() {
  const payload = useErrorDialogStore((s) => s.payload);
  const close = useErrorDialogStore((s) => s.close);

  return (
    <Dialog
      open={payload !== null}
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertCircle className="size-5 shrink-0 text-rose-400" />
            {payload?.title ?? "Error"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Error details
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 font-sans text-sm text-rose-100">
          {payload?.message}
        </pre>
        <DialogFooter>
          <Button type="button" onClick={close}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
