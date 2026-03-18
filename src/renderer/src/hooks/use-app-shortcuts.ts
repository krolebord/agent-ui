import { useConfirmDialogStore } from "@renderer/components/confirm-dialog";
import { useNewSessionDialogStore } from "@renderer/components/new-session-dialog";
import { useProjectDefaultsDialogStore } from "@renderer/components/project-defaults-dialog";
import { useProjectWorktreeDialogStore } from "@renderer/components/project-worktree-dialog";
import { useSettingsStore } from "@renderer/components/settings-dialog";
import { useAppState } from "@renderer/components/sync-state-provider";
import { orpc } from "@renderer/orpc-client";
import {
  buildProjectSessionGroups,
  getVisibleSessionIds,
} from "@renderer/services/terminal-session-selectors";
import { useHotkey } from "@tanstack/react-hotkeys";
import type { Session } from "src/main/sessions/state";
import { switchSession, useActiveSessionId } from "./use-active-session-id";

export const SHORTCUT_DEFINITIONS = [
  { id: "new-session", label: "New session", key: "N", cmdOrCtrl: true },
  { id: "next-session", label: "Next session", key: "J", cmdOrCtrl: true },
  {
    id: "session-above",
    label: "Session above",
    key: "↑",
    cmdOrCtrl: true,
  },
  {
    id: "session-below",
    label: "Session below",
    key: "↓",
    cmdOrCtrl: true,
  },
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
  const projects = useAppState((state) => state.projects);
  const activeSessionId = useActiveSessionId();

  const confirmDialogOpen = useConfirmDialogStore(
    (state) => state.options !== null,
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
  const openProjectWorktreeDialogPath = useProjectWorktreeDialogStore(
    (state) => state.openProjectPath,
  );

  const dialogsAreOpen =
    confirmDialogOpen ||
    Boolean(openNewSessionDialogCwd) ||
    openSettingsDialog ||
    Boolean(openProjectDefaultsDialogCwd) ||
    Boolean(openProjectWorktreeDialogPath);

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
      switchSession(nextSessionId);
    },
    { enabled: !dialogsAreOpen },
  );

  useHotkey(
    "Mod+ArrowUp",
    () => {
      if (!activeSessionId) return;
      const groups = buildProjectSessionGroups({
        projects,
        sessionsById: sessions,
      });
      const ordered = getVisibleSessionIds(groups);
      const idx = ordered.indexOf(activeSessionId);
      if (idx === -1 || ordered.length === 0) return;
      const prev = (idx - 1 + ordered.length) % ordered.length;
      switchSession(ordered[prev]);
    },
    { enabled: !dialogsAreOpen },
  );

  useHotkey(
    "Mod+ArrowDown",
    () => {
      if (!activeSessionId) return;
      const groups = buildProjectSessionGroups({
        projects,
        sessionsById: sessions,
      });
      const ordered = getVisibleSessionIds(groups);
      const idx = ordered.indexOf(activeSessionId);
      if (idx === -1 || ordered.length === 0) return;
      const next = (idx + 1) % ordered.length;
      switchSession(ordered[next]);
    },
    { enabled: !dialogsAreOpen },
  );

  useHotkey(
    "Mod+Backspace",
    () => {
      if (!activeSessionId) return;

      const session = sessions[activeSessionId];
      if (!session) return;

      useConfirmDialogStore.getState().confirm({
        title: "Delete session",
        description: `Delete "${session.title || "Untitled"}"? This cannot be undone.`,
        confirmLabel: "Delete",
        onConfirm: async () => {
          const nextSessionId = getNextSession(
            sessions,
            activeSessionId,
            activeSessionId,
          );

          switch (session.type) {
            case "claude-local-terminal":
              await orpc.sessions.localClaude.deleteSession.call({
                sessionId: activeSessionId,
              });
              break;
            case "local-terminal":
              await orpc.sessions.localTerminal.deleteSession.call({
                sessionId: activeSessionId,
              });
              break;
            case "ralph-loop":
              await orpc.sessions.ralphLoop.deleteSession.call({
                sessionId: activeSessionId,
              });
              break;
            case "codex-local-terminal":
              await orpc.sessions.codex.deleteSession.call({
                sessionId: activeSessionId,
              });
              break;
          }
          switchSession(nextSessionId);
        },
      });
    },
    { enabled: !dialogsAreOpen },
  );
}
