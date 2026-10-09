import { setTimeout as delay } from "node:timers/promises";
import type { SessionsServiceNew } from "../session-service";
import type { CodexSessionsManager } from "../sessions/codex.session";
import type { CursorAgentSessionsManager } from "../sessions/cursor-agent.session";
import type { Session, SessionServiceState } from "../sessions/state";
import type { SkillsService } from "../skills-service";
import type { TerminalManager } from "../terminal-manager";

interface Dependencies {
  sessions: SessionServiceState;
  terminalManager: Pick<TerminalManager, "writeToTerminal"> & {
    getRuntime: (
      id: string,
    ) => Pick<
      NonNullable<ReturnType<TerminalManager["getRuntime"]>>,
      "status"
    > | null;
  };
  claude: Pick<SessionsServiceNew, "resumeSession">;
  codex: Pick<CodexSessionsManager, "startLiveSession">;
  cursor: Pick<CursorAgentSessionsManager, "startLiveSession">;
  skills: Pick<SkillsService, "ensureFreshForPath">;
  isProjectLocked: (path: string) => boolean;
}

export function createPromptDelivery(deps: Dependencies) {
  return async (session: Session, prompt: string): Promise<void> => {
    if (deps.isProjectLocked(session.startupConfig.cwd))
      throw new Error(
        "Project is busy. Try sending this prompt after the project operation finishes.",
      );
    if (session.status === "stopped") {
      await deps.skills.ensureFreshForPath(session.startupConfig.cwd);
      if (deps.sessions.state[session.sessionId]?.status !== "stopped")
        throw new Error(
          "Session changed while preparing the prompt. Try sending again.",
        );
      switch (session.type) {
        case "claude-local-terminal":
          await deps.claude.resumeSession(
            { sessionId: session.sessionId, cols: 120, rows: 36 },
            { prompt },
          );
          return;
        case "codex-local-terminal":
          if (!session.codexSessionId)
            throw new Error(
              "Start this session before scheduling follow-up prompts.",
            );
          await deps.codex.startLiveSession({
            ...session.startupConfig,
            sessionId: session.sessionId,
            codexSessionId: session.codexSessionId,
            permissionMode: session.startupConfig.permissionMode,
            initialPrompt: prompt,
            cols: 120,
            rows: 36,
          });
          return;
        case "cursor-agent":
          if (!session.cursorChatId)
            throw new Error(
              "Start this session before scheduling follow-up prompts.",
            );
          await deps.cursor.startLiveSession({
            ...session.startupConfig,
            sessionId: session.sessionId,
            cursorChatId: session.cursorChatId,
            permissionMode: session.startupConfig.permissionMode,
            mode: session.startupConfig.mode,
            initialPrompt: prompt,
            cols: 120,
            rows: 36,
          });
          return;
        default:
          throw new Error("This session cannot receive scheduled prompts.");
      }
    }
    if (
      session.status !== "idle" &&
      session.status !== "awaiting_user_response"
    )
      throw new Error(
        "Session is busy. Try sending again when the current turn finishes.",
      );
    const runtime = deps.terminalManager.getRuntime(session.sessionId);
    if (runtime?.status !== "running")
      throw new Error(
        "Session terminal is unavailable. Resume the session and try again.",
      );
    deps.terminalManager.writeToTerminal(
      session.sessionId,
      `\x1b[200~${prompt.replace(/\r\n?/g, "\n")}\x1b[201~`,
    );
    await delay(100);
    if (deps.terminalManager.getRuntime(session.sessionId) !== runtime)
      throw new Error(
        "Session stopped while sending. Check the conversation before sending again.",
      );
    const current = deps.sessions.state[session.sessionId];
    if (
      current?.status !== "idle" &&
      current?.status !== "awaiting_user_response"
    )
      throw new Error(
        "Session became busy while sending. Check the prompt input before sending again.",
      );
    deps.terminalManager.writeToTerminal(
      session.sessionId,
      session.type === "codex-local-terminal" ? "\x1b[13u" : "\r",
    );
  };
}
