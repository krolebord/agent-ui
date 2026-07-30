import type { Session } from "@main/sessions/state";
import { useActiveSessionStore } from "@renderer/hooks/use-active-session-id";
import { getTerminalSize } from "@renderer/hooks/use-terminal-size";
import { orpc } from "@renderer/orpc-client";
import { useMutation } from "@tanstack/react-query";

/**
 * Start/stop/delete for every session type, in one place so both the project
 * tree and the inbox drive sessions identically. Type-specific extras that are
 * not lifecycle (fork, Claude's remote-control toggle) stay with the view that
 * offers them.
 */

/** Stops a live session, whatever its type. Also used for bulk stop. */
export async function stopSession(session: Session): Promise<void> {
  switch (session.type) {
    case "claude-local-terminal":
      await orpc.sessions.localClaude.stopLiveSession.call({
        sessionId: session.sessionId,
      });
      return;
    case "local-terminal":
      await orpc.sessions.localTerminal.stopLiveSession.call({
        sessionId: session.sessionId,
      });
      return;
    case "codex-local-terminal":
      await orpc.sessions.codex.stopLiveSession.call({
        sessionId: session.sessionId,
      });
      return;
    case "cursor-agent":
      await orpc.sessions.cursorAgent.stopLiveSession.call({
        sessionId: session.sessionId,
      });
      return;
    case "worktree-setup":
      await orpc.sessions.worktreeSetup.cancelSetup.call({
        sessionId: session.sessionId,
      });
      return;
    default: {
      const exhaustiveCheck = session satisfies never;
      return exhaustiveCheck;
    }
  }
}

/**
 * Resumes a stopped session. Terminal-backed types need the current terminal
 * size so the PTY comes back at the right dimensions. Worktree setup has no
 * resume path — it runs once and is cancelled or kept.
 */
async function resumeSession(session: Session): Promise<void> {
  const { cols, rows } = getTerminalSize();
  switch (session.type) {
    case "claude-local-terminal":
      await orpc.sessions.localClaude.resumeSession.call({
        sessionId: session.sessionId,
        cols,
        rows,
      });
      return;
    case "local-terminal":
      await orpc.sessions.localTerminal.resumeSession.call({
        sessionId: session.sessionId,
        cols,
        rows,
      });
      return;
    case "codex-local-terminal":
      await orpc.sessions.codex.resumeSession.call({
        sessionId: session.sessionId,
        cols,
        rows,
      });
      return;
    case "cursor-agent":
      await orpc.sessions.cursorAgent.resumeSession.call({
        sessionId: session.sessionId,
        cols,
        rows,
      });
      return;
    case "worktree-setup":
      return;
    default: {
      const exhaustiveCheck = session satisfies never;
      return exhaustiveCheck;
    }
  }
}

async function deleteSession(session: Session): Promise<void> {
  switch (session.type) {
    case "claude-local-terminal":
      await orpc.sessions.localClaude.deleteSession.call({
        sessionId: session.sessionId,
      });
      return;
    case "local-terminal":
      await orpc.sessions.localTerminal.deleteSession.call({
        sessionId: session.sessionId,
      });
      return;
    case "codex-local-terminal":
      await orpc.sessions.codex.deleteSession.call({
        sessionId: session.sessionId,
      });
      return;
    case "cursor-agent":
      await orpc.sessions.cursorAgent.deleteSession.call({
        sessionId: session.sessionId,
      });
      return;
    case "worktree-setup":
      await orpc.sessions.worktreeSetup.deleteSession.call({
        sessionId: session.sessionId,
      });
      return;
    default: {
      const exhaustiveCheck = session satisfies never;
      return exhaustiveCheck;
    }
  }
}

/** Worktree setup runs once, so it is cancellable but never resumable. */
export function sessionCanResume(session: Session): boolean {
  return session.type !== "worktree-setup" && session.status === "stopped";
}

export function sessionCanStop(session: Session): boolean {
  if (session.type === "worktree-setup") {
    return session.status === "running" || session.status === "starting";
  }
  return session.status !== "stopped";
}

function navigateAwayIfActive(sessionId: string) {
  if (useActiveSessionStore.getState().activeSessionId === sessionId) {
    useActiveSessionStore.getState().setActiveSessionId(null);
  }
}

export interface SessionLifecycleActions {
  /** Null when this session cannot be resumed right now. */
  resume: (() => void) | null;
  /** Null when there is nothing to stop right now. */
  stop: (() => void) | null;
  /** Worktree setup cancels rather than stops. */
  stopLabel: string;
  remove: () => void;
  isResumePending: boolean;
  isStopPending: boolean;
  isRemovePending: boolean;
}

/**
 * Accepts undefined so callers can keep their "session missing" guard below the
 * hook calls, where React requires it to stay.
 */
export function useSessionLifecycleActions(
  session: Session | undefined,
): SessionLifecycleActions {
  const resumeMutation = useMutation({ mutationFn: resumeSession });
  const stopMutation = useMutation({ mutationFn: stopSession });
  const removeMutation = useMutation({
    mutationFn: deleteSession,
    onSuccess: (_result, removed) => navigateAwayIfActive(removed.sessionId),
  });

  return {
    resume:
      session !== undefined && sessionCanResume(session)
        ? () => resumeMutation.mutate(session)
        : null,
    stop:
      session !== undefined && sessionCanStop(session)
        ? () => stopMutation.mutate(session)
        : null,
    stopLabel:
      session?.type === "worktree-setup" ? "Cancel setup" : "Stop session",
    remove: () => {
      if (session !== undefined) removeMutation.mutate(session);
    },
    isResumePending: resumeMutation.isPending,
    isStopPending: stopMutation.isPending,
    isRemovePending: removeMutation.isPending,
  };
}
