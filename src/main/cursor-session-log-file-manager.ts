import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const CURSOR_SESSION_LOGS_DIR = "claude-state";

export class CursorSessionLogFileManager {
  private readonly userDataPath: string;

  constructor(userDataPath: string) {
    this.userDataPath = userDataPath;
  }

  create(sessionId: string): string {
    const logsDir = path.join(this.userDataPath, CURSOR_SESSION_LOGS_DIR);
    const logFilePath = path.join(logsDir, `cursor-${sessionId}.ndjson`);

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
