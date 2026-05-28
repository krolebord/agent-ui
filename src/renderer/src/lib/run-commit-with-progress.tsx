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
};

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
    toast.success("Commit created", { id: toastId });
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
