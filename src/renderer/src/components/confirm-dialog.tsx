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
import { useMutation } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { combine } from "zustand/middleware";

export interface ConfirmDialogCheckboxOption {
  id: string;
  label: string;
  description?: string;
  defaultChecked?: boolean;
  disabled?: boolean;
}

interface ConfirmDialogOptions {
  title: string;
  description: string;
  confirmLabel?: string;
  checkboxes?: ConfirmDialogCheckboxOption[];
  normalizeCheckboxValues?: (
    values: Record<string, boolean>,
    changedCheckboxId: string,
  ) => Record<string, boolean>;
  onConfirm: (values: Record<string, boolean>) => Promise<void> | void;
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
  const [checkboxValues, setCheckboxValues] = useState<Record<string, boolean>>(
    {},
  );

  useEffect(() => {
    const nextValues = Object.fromEntries(
      (options?.checkboxes ?? []).map((checkbox) => [
        checkbox.id,
        checkbox.defaultChecked === true,
      ]),
    );
    setCheckboxValues(nextValues);
  }, [options]);

  const mutation = useMutation({
    mutationFn: async () => {
      await options?.onConfirm(checkboxValues);
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
        {options?.checkboxes?.length ? (
          <div className="space-y-3">
            {options.checkboxes.map((checkbox) => (
              <div
                key={checkbox.id}
                className="flex items-start gap-3 rounded-lg border border-border/60 px-3 py-2"
              >
                <Checkbox
                  id={`confirm-checkbox-${checkbox.id}`}
                  checked={checkboxValues[checkbox.id] === true}
                  disabled={mutation.isPending || checkbox.disabled}
                  onCheckedChange={(checked) => {
                    const nextValues = {
                      ...checkboxValues,
                      [checkbox.id]: checked === true,
                    };
                    setCheckboxValues(
                      options.normalizeCheckboxValues
                        ? options.normalizeCheckboxValues(
                            nextValues,
                            checkbox.id,
                          )
                        : nextValues,
                    );
                  }}
                />
                <div className="space-y-1">
                  <Label
                    htmlFor={`confirm-checkbox-${checkbox.id}`}
                    className="leading-5"
                  >
                    {checkbox.label}
                  </Label>
                  {checkbox.description ? (
                    <p className="text-sm text-muted-foreground">
                      {checkbox.description}
                    </p>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : null}
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
