import type { NavPageId } from "@shared/sidebar-nav";
import { create } from "zustand";
import { combine } from "zustand/middleware";

export type MainView = "sessions" | NavPageId;

export const useMainViewStore = create(
  combine(
    {
      view: "sessions" as MainView,
      artifactsSessionId: null as string | null,
    },
    (set) => ({
      showSessions: () => {
        set({ view: "sessions" });
      },
      showSkills: () => {
        set({ view: "skills" });
      },
      showGlobalInstructions: () => {
        set({ view: "globalInstructions" });
      },
      showScheduledSessions: () => {
        set({ view: "scheduledSessions" });
      },
      showAccounts: () => {
        set({ view: "accounts" });
      },
      showArtifacts: (sessionId: string | null = null) => {
        set({ view: "artifacts", artifactsSessionId: sessionId });
      },
      clearArtifactsSessionFilter: () => {
        set({ artifactsSessionId: null });
      },
      showUsage: () => {
        set({ view: "usage" });
      },
      showLimits: () => {
        set({ view: "limits" });
      },
      toggleView: (view: NavPageId) => {
        set((state) => ({
          view: state.view === view ? "sessions" : view,
          artifactsSessionId: null,
        }));
      },
    }),
  ),
);
