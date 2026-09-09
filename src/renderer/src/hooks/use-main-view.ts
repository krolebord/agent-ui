import { create } from "zustand";
import { combine } from "zustand/middleware";

export type MainView =
  | "sessions"
  | "skills"
  | "globalInstructions"
  | "scheduledSessions"
  | "accounts"
  | "artifacts"
  | "usage";

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
    showGlobalInstructions: () => {
      set({ view: "globalInstructions" });
    },
    toggleGlobalInstructions: () => {
      set((state) => ({
        view:
          state.view === "globalInstructions"
            ? "sessions"
            : "globalInstructions",
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
    showUsage: () => {
      set({ view: "usage" });
    },
    toggleUsage: () => {
      set((state) => ({
        view: state.view === "usage" ? "sessions" : "usage",
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
