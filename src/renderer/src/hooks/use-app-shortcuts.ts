import { useNewSessionDialogStore } from "@renderer/components/new-session-dialog";
import { useProjectDefaultsDialogStore } from "@renderer/components/project-defaults-dialog";
import { useSettingsStore } from "@renderer/components/settings-dialog";
import { useAppState } from "@renderer/components/sync-state-provider";
import { orpc } from "@renderer/orpc-client";
import { useHotkey } from "@tanstack/react-hotkeys";
import type { Session } from "src/main/sessions/state";
import {
  useActiveSessionId,
  useActiveSessionStore,
} from "./use-active-session-id";

export const SHORTCUT_DEFINITIONS = [
  { id: "new-session", label: "New session", key: "N", cmdOrCtrl: true },
  { id: "next-session", label: "Next session", key: "J", cmdOrCtrl: true },
  {
    id: "delete-session",
    label: "Delete session",
    key: "⌫",
    cmdOrCtrl: true,
  },
] as const;

export function getNextSession(
  sessionsById: Record<string, Session>,
  activeSessionId: string | null,
  excludeSessionId?: string,
): string | null {
  const activeId = activeSessionId;
  const sessions = Object.values(sessionsById);
  const activeSession = activeId ? sessionsById[activeId] : null;
  const activeCwd = activeSession?.startupConfig.cwd ?? null;

  const candidates = sessions.filter(
    (session) =>
      session.sessionId !== activeId && session.sessionId !== excludeSessionId,
  );

  if (candidates.length === 0) return null;

  const awaitingStates = new Set([
    "awaiting_user_response",
    "awaiting_approval",
  ]);

  const isAwaiting = (session: Session) => awaitingStates.has(session.status);

  const byRecent = (a: Session, b: Session) =>
    b.lastActivityAt - a.lastActivityAt;

  if (activeCwd) {
    const tier1 = candidates
      .filter(
        (session) =>
          isAwaiting(session) && session.startupConfig.cwd === activeCwd,
      )
      .sort(byRecent);
    if (tier1.length > 0) return tier1[0].sessionId;
  }

  const tier2 = candidates
    .filter(
      (session) =>
        isAwaiting(session) && session.startupConfig.cwd !== activeCwd,
    )
    .sort(byRecent);
  if (tier2.length > 0) return tier2[0].sessionId;

  const tier3 = candidates.sort(byRecent);
  if (tier3.length > 0) return tier3[0].sessionId;

  return null;
}

export function useAppShortcuts(): void {
  const sessions = useAppState((state) => state.sessions);
  const activeSessionId = useActiveSessionId();
  const setActiveSessionId = useActiveSessionStore(
    (state) => state.setActiveSessionId,
  );

  const openSettingsDialog = useSettingsStore((state) => state.isOpen);
  const openNewSessionDialogCwd = useNewSessionDialogStore(
    (state) => state.openProjectCwd,
  );
  const setOpenNewSessionDialogCwd = useNewSessionDialogStore(
    (state) => state.setOpenProjectCwd,
  );
  const openProjectDefaultsDialogCwd = useProjectDefaultsDialogStore(
    (state) => state.openProjectCwd,
  );

  const dialogsAreOpen =
    Boolean(openNewSessionDialogCwd) ||
    openSettingsDialog ||
    Boolean(openProjectDefaultsDialogCwd);

  useHotkey(
    "Mod+N",
    () => {
      if (!activeSessionId) return;
      const activeSession = sessions[activeSessionId];
      if (!activeSession) return;

      setOpenNewSessionDialogCwd(activeSession.startupConfig.cwd);
    },
    { enabled: !dialogsAreOpen },
  );

  useHotkey(
    "Mod+J",
    () => {
      const nextSessionId = getNextSession(sessions, activeSessionId);
      if (!nextSessionId) return;
      setActiveSessionId(nextSessionId);
    },
    { enabled: !dialogsAreOpen },
  );

  useHotkey(
    "Mod+Backspace",
    () => {
      if (!activeSessionId) return;

      const nextSessionId = getNextSession(
        sessions,
        activeSessionId,
        activeSessionId,
      );
      const deletingSessionId = activeSessionId;

      switch (sessions[deletingSessionId].type) {
        case "claude-local-terminal":
          void orpc.sessions.localClaude.deleteSession.call({
            sessionId: deletingSessionId,
          });
          break;
        case "local-terminal":
          void orpc.sessions.localTerminal.deleteSession.call({
            sessionId: deletingSessionId,
          });
          break;
      }
      setActiveSessionId(nextSessionId);
    },
    { enabled: !dialogsAreOpen },
  );
}
