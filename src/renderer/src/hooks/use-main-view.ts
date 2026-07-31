import { create } from "zustand";
import { combine } from "zustand/middleware";

export type MainView =
  | "sessions"
  | "skills"
  | "scheduledSessions"
  | "accounts"
  | "artifacts";

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
    showAccounts: () => {
      set({ view: "accounts" });
    },
    showArtifacts: () => {
      set({ view: "artifacts" });
    },
    toggleArtifacts: () => {
      set((state) => ({
        view: state.view === "artifacts" ? "sessions" : "artifacts",
      }));
    },
    toggleAccounts: () => {
      set((state) => ({
        view: state.view === "accounts" ? "sessions" : "accounts",
      }));
    },
    toggleScheduledSessions: () => {
      set((state) => ({
        view:
          state.view === "scheduledSessions" ? "sessions" : "scheduledSessions",
      }));
    },
  })),
);
