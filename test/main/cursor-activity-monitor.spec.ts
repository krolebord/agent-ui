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

  it("reduces hook events in a per-session file to activity states", async () => {
    const filePath = path.join(tempDir, "events.ndjson");
    const onStatusChange = vi.fn();
    const monitor = new CursorActivityMonitor({ onStatusChange });

    await monitor.startMonitoring({
      stateFilePath: filePath,
    });

    await appendRaw(
      filePath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        hook_event_name: "preToolUse",
      })}\n`,
    );
    await appendRaw(
      filePath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        hook_event_name: "stop",
        status: "completed",
      })}\n`,
    );
    await appendRaw(
      filePath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        hook_event_name: "sessionEnd",
      })}\n`,
    );

    await vi.waitFor(() => {
      expect(onStatusChange).toHaveBeenCalledWith("working");
      expect(onStatusChange).toHaveBeenCalledWith("awaiting_user_response");
      expect(onStatusChange).toHaveBeenCalledWith("idle");
    });

    monitor.stopMonitoring();
  });

  it("emits hook events without conversation filtering", async () => {
    const filePath = path.join(tempDir, "events.ndjson");
    const onStatusChange = vi.fn();
    const onHookEvent = vi.fn();
    const monitor = new CursorActivityMonitor({ onStatusChange, onHookEvent });

    await monitor.startMonitoring({
      stateFilePath: filePath,
    });

    await appendRaw(
      filePath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        hook_event_name: "preToolUse",
        conversation_id: "chat-2",
      })}\n`,
    );

    await vi.waitFor(() => {
      expect(onHookEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          conversation_id: "chat-2",
          hook_event_name: "preToolUse",
        }),
      );
      expect(onStatusChange).toHaveBeenCalledWith("working");
    });

    monitor.stopMonitoring();
  });
});
