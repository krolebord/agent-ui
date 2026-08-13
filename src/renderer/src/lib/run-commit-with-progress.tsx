import { createClickableErrorToastResult } from "@renderer/lib/clickable-error-toast";
import { orpc } from "@renderer/orpc-client";
import { toast } from "sonner";

type CommitInput = {
  path: string;
  filePaths: string[];
  subject?: string;
  description?: string;
};

type CommitHandlers = {
  onCommitted?: () => void;
  onUndone?: () => void;
};

const undoToastDurationMs = 8_000;

export async function runCommitWithProgress(
  input: CommitInput,
  handlers: CommitHandlers = {},
): Promise<void> {
  const toastId = toast.loading("Creating commit…");

  try {
    const stream = await orpc.projects.commitSelectedChanges.call(input);
    for await (const event of stream) {
      switch (event.stage) {
        case "committed":
          handlers.onCommitted?.();
          break;
        case "generating":
          toast.loading("Generating commit message…", { id: toastId });
          break;
      }
    }

    let undoStarted = false;
    toast.success("Commit created", {
      id: toastId,
      duration: undoToastDurationMs,
      action: {
        label: "Undo",
        onClick: () => {
          if (undoStarted) {
            return;
          }
          undoStarted = true;
          void (async () => {
            try {
              await orpc.projects.undoLastCommit.call({ path: input.path });
              handlers.onUndone?.();
              toast.success("Commit undone");
            } catch (error) {
              const { message } = createClickableErrorToastResult(
                error,
                "Undo failed",
                "Failed to undo commit.",
              );
              toast.error(message);
            }
          })();
        },
      },
    });
  } catch (error) {
    const { message } = createClickableErrorToastResult(
      error,
      "Commit failed",
      "Commit failed.",
    );
    toast.error(message, { id: toastId });
    throw error;
  }
}
