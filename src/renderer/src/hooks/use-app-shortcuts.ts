import { useNewSessionDialogStore } from "@renderer/components/new-session-dialog";
import { useProjectDefaultsDialogStore } from "@renderer/components/project-defaults-dialog";
import { useSettingsStore } from "@renderer/components/settings-dialog";
import { useAppState } from "@renderer/components/sync-state-provider";
import { orpc } from "@renderer/orpc-client";
import type { ClaudeSession } from "src/main/session-service";
import {
  useActiveSessionId,
  useActiveSessionStore,
} from "./use-active-session-id";
import { useKeyboardShortcut } from "./use-keyboard-shortcut";

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
  sessionsById: Record<string, ClaudeSession>,
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

  const isAwaiting = (session: ClaudeSession) =>
    awaitingStates.has(session.activity.state);

  const byRecent = (a: ClaudeSession, b: ClaudeSession) =>
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

  const tier3 = candidates
    .filter(
      (session) =>
        session.terminal.status === "running" &&
        session.activity.state === "idle",
    )
    .sort(byRecent);
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

  useKeyboardShortcut({
    key: "n",
    meta: true,
    enabled: !dialogsAreOpen,
    callback: () => {
      if (!activeSessionId) return;
      const activeSession = sessions[activeSessionId];
      if (!activeSession) return;

      setOpenNewSessionDialogCwd(activeSession.startupConfig.cwd);
    },
  });

  useKeyboardShortcut({
    key: "j",
    meta: true,
    enabled: !dialogsAreOpen,
    callback: () => {
      const nextSessionId = getNextSession(sessions, activeSessionId);
      if (!nextSessionId) return;
      setActiveSessionId(nextSessionId);
    },
  });

  useKeyboardShortcut({
    key: "backspace",
    meta: true,
    enabled: !dialogsAreOpen,
    callback: () => {
      if (!activeSessionId) return;

      const nextSessionId = getNextSession(
        sessions,
        activeSessionId,
        activeSessionId,
      );
      const deletingSessionId = activeSessionId;
      void orpc.sessions.deleteSession
        .call({ sessionId: deletingSessionId })
        .then(() => {
          setActiveSessionId(nextSessionId);
        });
    },
  });
}
