import { useAppState } from "@renderer/components/sync-state-provider";
import { hasNativeDesktopShell } from "@renderer/lib/native-shell";
import {
  restoreAttentionFavicon,
  updateAttentionFavicon,
} from "@renderer/services/attention-favicon";
import { countAttentionSessions } from "@shared/session-attention";
import { useEffect } from "react";

export function useAttentionFavicon() {
  const attentionCount = useAppState((state) =>
    countAttentionSessions(Object.values(state.sessions)),
  );

  useEffect(() => {
    if (hasNativeDesktopShell) {
      return;
    }
    updateAttentionFavicon(attentionCount);
  }, [attentionCount]);

  useEffect(
    () => () => {
      if (!hasNativeDesktopShell) {
        restoreAttentionFavicon();
      }
    },
    [],
  );
}
