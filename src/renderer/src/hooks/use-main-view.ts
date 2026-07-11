import { create } from "zustand";
import { combine } from "zustand/middleware";

export type MainView = "sessions" | "skills";

export const useMainViewStore = create(
  combine({ view: "sessions" as MainView }, (set) => ({
    showSessions: () => {
      set({ view: "sessions" });
    },
    showSkills: () => {
      set({ view: "skills" });
    },
    toggleSkills: () => {
      set((state) => ({
        view: state.view === "skills" ? "sessions" : "skills",
      }));
    },
  })),
);
