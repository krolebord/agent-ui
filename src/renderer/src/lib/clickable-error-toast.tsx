import { useErrorDialogStore } from "@renderer/components/error-dialog";
import { formatErrorMessage } from "@renderer/lib/format-error-message";
import type { ReactNode } from "react";

export function createClickableErrorToastResult(
  error: unknown,
  dialogTitle: string,
  fallbackMessage = "An unexpected error occurred.",
) {
  const message = formatErrorMessage(error) || fallbackMessage;

  return {
    message: (
      <button
        type="button"
        className="flex w-full cursor-pointer flex-col gap-1 text-left"
        onClick={(event) => {
          event.preventDefault();
          useErrorDialogStore.getState().open({
            title: dialogTitle,
            message,
          });
        }}
      >
        <span>{message}</span>
        <span className="text-xs text-muted-foreground">Click for details</span>
      </button>
    ) satisfies ReactNode,
  };
}
