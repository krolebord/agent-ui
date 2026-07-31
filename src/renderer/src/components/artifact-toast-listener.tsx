import { useAppState } from "@renderer/components/sync-state-provider";
import { useMainViewStore } from "@renderer/hooks/use-main-view";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

export function ArtifactToastListener() {
  const artifacts = useAppState((state) => state.artifacts);
  const knownIds = useRef<Set<string> | null>(null);

  useEffect(() => {
    const currentIds = new Set(Object.keys(artifacts));
    if (knownIds.current === null) {
      knownIds.current = currentIds;
      return;
    }

    for (const artifact of Object.values(artifacts)) {
      if (knownIds.current.has(artifact.id)) continue;
      toast.success(`Artifact created: ${artifact.name}`, {
        action: {
          label: "View artifacts",
          onClick: () => useMainViewStore.getState().showArtifacts(),
        },
      });
    }
    knownIds.current = currentIds;
  }, [artifacts]);

  return null;
}
