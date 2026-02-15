import { generateSessionTitle } from "./generate-session-title";
import log from "./logger";

interface SessionTitleManagerOptions {
  generateTitle?: (prompt: string) => Promise<string>;
}

export class SessionTitleManager {
  private readonly triggered = new Set<string>();
  private readonly generateTitle: (prompt: string) => Promise<string>;

  constructor(options?: SessionTitleManagerOptions) {
    this.generateTitle = options?.generateTitle ?? generateSessionTitle;
  }

  markTriggered(sessionId: string): void {
    this.triggered.add(sessionId);
  }

  forget(sessionId: string): void {
    this.triggered.delete(sessionId);
  }

  maybeGenerate(params: {
    sessionId: string;
    prompt: string;
    sessionExists: () => boolean;
    onTitleReady: (title: string) => void;
  }): void {
    if (this.triggered.has(params.sessionId)) {
      return;
    }

    this.triggered.add(params.sessionId);
    log.info("Title generation triggered", { sessionId: params.sessionId });

    void this.generateTitle(params.prompt)
      .then((title) => {
        if (!params.sessionExists()) {
          return;
        }

        log.info("Title generation completed", {
          sessionId: params.sessionId,
          title,
        });
        params.onTitleReady(title);
      })
      .catch((error) => {
        log.error("Title generation failed", {
          sessionId: params.sessionId,
          error,
        });
      });
  }
}
