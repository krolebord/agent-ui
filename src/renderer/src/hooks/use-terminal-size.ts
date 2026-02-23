import { create } from "zustand";
import { combine } from "zustand/middleware";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export const useTerminalSizeStore = create(
  combine(
    {
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    },
    (set) => ({
      setSize: (cols: number, rows: number) => {
        set({ cols, rows });
      },
    }),
  ),
);

export function getTerminalSize() {
  const { cols, rows } = useTerminalSizeStore.getState();
  return { cols, rows };
}
