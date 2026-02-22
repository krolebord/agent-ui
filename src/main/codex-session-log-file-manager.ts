import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const CODEX_SESSION_LOGS_DIR = "claude-state";

export class CodexSessionLogFileManager {
  private readonly userDataPath: string;

  constructor(userDataPath: string) {
    this.userDataPath = userDataPath;
  }

  create(sessionId: string): string {
    const logsDir = path.join(this.userDataPath, CODEX_SESSION_LOGS_DIR);
    const logFilePath = path.join(logsDir, `codex-${sessionId}.jsonl`);

    mkdirSync(logsDir, { recursive: true });
    writeFileSync(logFilePath, "", "utf8");

    return logFilePath;
  }

  cleanup(logFilePath: string | null): void {
    if (!logFilePath) {
      return;
    }

    try {
      unlinkSync(logFilePath);
    } catch {
      // Ignore missing-file and cleanup errors.
    }
  }
}
