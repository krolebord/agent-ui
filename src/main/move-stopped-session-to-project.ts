import type { Services } from "./create-services";
import { assertProjectPathInteractionAllowed } from "./project-service";

export function moveStoppedSessionToProject(
  context: Services,
  sessionId: string,
  targetProjectPathRaw: string,
): void {
  const targetProjectPath = targetProjectPathRaw.trim();
  if (!targetProjectPath) {
    throw new Error("Project path is required.");
  }

  const tracked = context.projectsState.state.some(
    (p) => p.path === targetProjectPath,
  );
  if (!tracked) {
    throw new Error("Drop the session onto a tracked project.");
  }

  assertProjectPathInteractionAllowed(targetProjectPath, context);

  const session = context.sessions.state.state[sessionId];
  if (!session) {
    throw new Error("Session not found.");
  }

  if (session.type === "worktree-setup") {
    throw new Error("This session type cannot be moved between projects.");
  }

  if (session.status !== "stopped") {
    throw new Error("Only stopped sessions can be moved.");
  }

  const currentCwd = session.startupConfig.cwd.trim();
  if (currentCwd === targetProjectPath) {
    return;
  }

  assertProjectPathInteractionAllowed(currentCwd, context);

  context.sessions.state.updateState((draft) => {
    const next = draft[sessionId];
    if (!next || next.status !== "stopped" || next.type === "worktree-setup") {
      return;
    }
    switch (next.type) {
      case "claude-local-terminal":
        next.startupConfig.cwd = targetProjectPath;
        return;
      case "local-terminal":
        next.startupConfig.cwd = targetProjectPath;
        return;
      case "codex-local-terminal":
        next.startupConfig.cwd = targetProjectPath;
        return;
      case "cursor-agent":
        next.startupConfig.cwd = targetProjectPath;
        return;
      case "ralph-loop":
        next.startupConfig.cwd = targetProjectPath;
        return;
      default: {
        const _unhandled: never = next;
        void _unhandled;
      }
    }
  });
}
