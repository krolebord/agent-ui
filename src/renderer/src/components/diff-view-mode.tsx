import { Button } from "@renderer/components/ui/button";
import { useIsMobile } from "@renderer/hooks/use-is-mobile";
import { Columns2, Rows3 } from "lucide-react";
import { create } from "zustand";
import { combine, persist } from "zustand/middleware";

const STORAGE_KEY = "agent-ui:diffViewMode";
const MOBILE_STORAGE_KEY = "agent-ui:diffViewMode:mobile";

export type DiffViewMode = "split" | "unified";

function createDiffViewModeStore(storageKey: string, initial: DiffViewMode) {
  return create(
    persist(
      combine(
        {
          mode: initial,
        },
        (set) => ({
          toggleMode: () => {
            set((state) => ({
              mode: state.mode === "split" ? "unified" : "split",
            }));
          },
        }),
      ),
      {
        name: storageKey,
      },
    ),
  );
}

export const useDiffViewModeStore = createDiffViewModeStore(
  STORAGE_KEY,
  "split",
);

// Split diffs don't fit narrow screens, so mobile keeps its own preference
// defaulting to unified.
export const useMobileDiffViewModeStore = createDiffViewModeStore(
  MOBILE_STORAGE_KEY,
  "unified",
);

function useEffectiveDiffViewModeStore() {
  const isMobile = useIsMobile();
  return isMobile ? useMobileDiffViewModeStore : useDiffViewModeStore;
}

export function useDiffViewMode(): DiffViewMode {
  const store = useEffectiveDiffViewModeStore();
  return store((state) => state.mode);
}

export function DiffViewModeToggle() {
  const store = useEffectiveDiffViewModeStore();
  const mode = store((state) => state.mode);
  const toggleMode = store((state) => state.toggleMode);
  const label =
    mode === "split" ? "Switch to unified view" : "Switch to split view";
  const Icon = mode === "split" ? Rows3 : Columns2;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-5 shrink-0 text-muted-foreground hover:text-zinc-200 pointer-coarse:size-8"
      onClick={toggleMode}
      aria-label={label}
      title={label}
    >
      <Icon className="size-3 pointer-coarse:size-4" />
    </Button>
  );
}
