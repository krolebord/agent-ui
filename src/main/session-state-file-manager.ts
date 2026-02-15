import { unlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export class SessionStateFileManager {
  private readonly userDataPath: string;

  constructor(userDataPath: string) {
    this.userDataPath = userDataPath;
  }

  async create(sessionId: string): Promise<string> {
    const stateDir = path.join(this.userDataPath, "claude-state");
    const stateFilePath = path.join(stateDir, `s-${sessionId}.ndjson`);

    await mkdir(stateDir, { recursive: true });
    await writeFile(stateFilePath, "", "utf8");

    return stateFilePath;
  }

  cleanup(stateFilePath: string | null): void {
    if (!stateFilePath) {
      return;
    }

    try {
      unlinkSync(stateFilePath);
    } catch {
      // Ignore missing-file and cleanup errors.
    }
  }
}
