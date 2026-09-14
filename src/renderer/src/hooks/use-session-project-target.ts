import type { ProjectSelection } from "@renderer/components/project-picker";
import { useAppStateStore } from "@renderer/components/sync-state-provider";
import { orpc } from "@renderer/orpc-client";
import type { SyncStateStore } from "@renderer/services/state-sync-client";
import { useCallback, useRef, useState } from "react";

export type SessionTargetStatus = "idle" | "creating" | "setup";

function waitForWorktreeSetup(
  store: SyncStateStore,
  sessionId: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribe?.();
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    const check = () => {
      const session = store.getState().sessions[sessionId];
      if (session?.type !== "worktree-setup") {
        finish();
        return;
      }
      if (session.status === "running") {
        return;
      }

      finish(
        session.status === "error"
          ? new Error(
              "Worktree setup failed. Submit again to start the session anyway.",
            )
          : undefined,
      );
    };

    unsubscribe = store.subscribe(check);
    check();
  });
}

export function useSessionProjectTarget(
  selection: ProjectSelection,
  worktreeName: string,
) {
  const store = useAppStateStore();
  const [status, setStatus] = useState<SessionTargetStatus>("idle");
  const createdRef = useRef<{ key: string; path: string } | null>(null);

  const resolve = useCallback(async (): Promise<string> => {
    if (selection.kind === "project") {
      return selection.path;
    }

    const name = worktreeName.trim();
    const key = `${selection.originPath}\n${name}`;
    const created = createdRef.current;
    if (created?.key === key) {
      return created.path;
    }

    setStatus("creating");
    try {
      const result = await orpc.projects.createSessionWorktree.call({
        sourcePath: selection.originPath,
        name: name || undefined,
      });
      createdRef.current = { key, path: result.path };

      if (result.setupSessionId) {
        setStatus("setup");
        await waitForWorktreeSetup(store, result.setupSessionId);
      }

      return result.path;
    } finally {
      setStatus("idle");
    }
  }, [selection, store, worktreeName]);

  const reset = useCallback(() => {
    createdRef.current = null;
    setStatus("idle");
  }, []);

  return { resolve, reset, status };
}
