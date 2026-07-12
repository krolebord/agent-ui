import { create } from "zustand";
import { combine } from "zustand/middleware";

export type MainView = "sessions" | "skills" | "scheduledSessions";

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
    showScheduledSessions: () => {
      set({ view: "scheduledSessions" });
    },
    toggleScheduledSessions: () => {
      set((state) => ({
        view:
          state.view === "scheduledSessions" ? "sessions" : "scheduledSessions",
      }));
    },
  })),
);
