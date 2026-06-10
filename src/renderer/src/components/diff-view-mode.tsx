import { Button } from "@renderer/components/ui/button";
import { Columns2, Rows3 } from "lucide-react";
import { create } from "zustand";
import { combine, persist } from "zustand/middleware";

const STORAGE_KEY = "agent-ui:diffViewMode";

export type DiffViewMode = "split" | "unified";

export const useDiffViewModeStore = create(
  persist(
    combine(
      {
        mode: "split" as DiffViewMode,
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
      name: STORAGE_KEY,
    },
  ),
);

export function useDiffViewMode(): DiffViewMode {
  return useDiffViewModeStore((state) => state.mode);
}

export function DiffViewModeToggle() {
  const mode = useDiffViewModeStore((state) => state.mode);
  const toggleMode = useDiffViewModeStore((state) => state.toggleMode);
  const label =
    mode === "split" ? "Switch to unified view" : "Switch to split view";
  const Icon = mode === "split" ? Rows3 : Columns2;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-5 shrink-0 text-muted-foreground hover:text-zinc-200"
      onClick={toggleMode}
      aria-label={label}
      title={label}
    >
      <Icon className="size-3" />
    </Button>
  );
}
