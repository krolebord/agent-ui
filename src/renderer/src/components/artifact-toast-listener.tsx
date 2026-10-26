import { useArtifactPreviewDialogStore } from "@renderer/components/artifacts-page";
import {
  useAppState,
  useAppStateStore,
} from "@renderer/components/sync-state-provider";
import {
  switchSession,
  useActiveSessionStore,
} from "@renderer/hooks/use-active-session-id";
import { useMainViewStore } from "@renderer/hooks/use-main-view";
import {
  getNewArtifactToastTitle,
  shouldToastNewArtifact,
} from "@renderer/lib/artifact-preview";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

export function ArtifactToastListener() {
  const store = useAppStateStore();
  const artifacts = useAppState((state) => state.artifacts);
  const knownIds = useRef<Set<string> | null>(null);

  useEffect(() => {
    const currentIds = new Set(Object.keys(artifacts));
    if (knownIds.current === null) {
      knownIds.current = currentIds;
      return;
    }

    const sessionInView =
      useMainViewStore.getState().view === "sessions"
        ? useActiveSessionStore.getState().activeSessionId
        : null;
    for (const artifact of Object.values(artifacts)) {
      if (knownIds.current.has(artifact.id)) continue;
      if (!shouldToastNewArtifact(artifact, sessionInView)) continue;
      const isVisual = artifact.kind === "visual";
      toast.success(getNewArtifactToastTitle(artifact), {
        action: {
          label: isVisual ? "View" : "Open session",
          onClick: () => {
            if (isVisual) {
              useArtifactPreviewDialogStore.getState().open(artifact.id);
            } else if (store.getState().sessions[artifact.sessionId]) {
              switchSession(artifact.sessionId);
            } else {
              useMainViewStore.getState().showArtifacts(artifact.sessionId);
            }
          },
        },
      });
    }
    knownIds.current = currentIds;
  }, [artifacts, store]);

  return null;
}
