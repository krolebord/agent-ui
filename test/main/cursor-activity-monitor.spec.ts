import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CursorActivityMonitor } from "../../src/main/cursor-activity-monitor";

async function appendRaw(filePath: string, value: string): Promise<void> {
  await writeFile(filePath, value, { encoding: "utf8", flag: "a" });
}

describe("CursorActivityMonitor", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "cursor-activity-monitor-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("reduces matching hook events to activity states", async () => {
    const filePath = path.join(tempDir, "events.ndjson");
    const onStatusChange = vi.fn();
    const monitor = new CursorActivityMonitor({ onStatusChange });

    await monitor.startMonitoring({
      stateFilePath: filePath,
      conversationId: "chat-1",
    });

    await appendRaw(
      filePath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        hook_event_name: "preToolUse",
        conversation_id: "chat-1",
      })}\n`,
    );
    await appendRaw(
      filePath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        hook_event_name: "stop",
        status: "completed",
        conversation_id: "chat-1",
      })}\n`,
    );
    await appendRaw(
      filePath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        hook_event_name: "sessionEnd",
        conversation_id: "chat-1",
      })}\n`,
    );

    await vi.waitFor(() => {
      expect(onStatusChange).toHaveBeenCalledWith("working");
      expect(onStatusChange).toHaveBeenCalledWith("awaiting_user_response");
      expect(onStatusChange).toHaveBeenCalledWith("idle");
    });

    monitor.stopMonitoring();
  });

  it("ignores events for other conversations", async () => {
    const filePath = path.join(tempDir, "events.ndjson");
    const onStatusChange = vi.fn();
    const monitor = new CursorActivityMonitor({ onStatusChange });

    await monitor.startMonitoring({
      stateFilePath: filePath,
      conversationId: "chat-1",
    });

    await appendRaw(
      filePath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        hook_event_name: "preToolUse",
        conversation_id: "chat-2",
      })}\n`,
    );

    await new Promise((resolve) => setTimeout(resolve, 140));
    expect(onStatusChange).not.toHaveBeenCalled();

    monitor.stopMonitoring();
  });
});
