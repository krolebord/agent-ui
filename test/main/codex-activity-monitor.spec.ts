import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexActivityMonitor } from "../../src/main/codex-activity-monitor";

async function appendRaw(filePath: string, value: string): Promise<void> {
  await writeFile(filePath, value, { encoding: "utf8", flag: "a" });
}

describe("CodexActivityMonitor", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "codex-activity-monitor-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("reduces existing log events to codex activity states", async () => {
    const filePath = path.join(tempDir, "codex-events.jsonl");
    await writeFile(
      filePath,
      `${[
        JSON.stringify({
          ts: new Date().toISOString(),
          dir: "meta",
          kind: "session_start",
        }),
        JSON.stringify({
          ts: new Date().toISOString(),
          dir: "to_tui",
          kind: "codex_event",
          payload: { msg: { type: "session_configured" } },
        }),
        JSON.stringify({
          ts: new Date().toISOString(),
          dir: "to_tui",
          kind: "app_event",
          variant: "CommitTick",
        }),
        JSON.stringify({
          ts: new Date().toISOString(),
          dir: "to_tui",
          kind: "codex_event",
          payload: { msg: { type: "task_started" } },
        }),
        JSON.stringify({
          ts: new Date().toISOString(),
          dir: "to_tui",
          kind: "codex_event",
          payload: { msg: { type: "request_user_input" } },
        }),
        JSON.stringify({
          ts: new Date().toISOString(),
          dir: "to_tui",
          kind: "codex_event",
          payload: { msg: { type: "task_complete" } },
        }),
      ].join("\n")}\n`,
      "utf8",
    );

    const onStatusChange = vi.fn();
    const monitor = new CodexActivityMonitor({ onStatusChange });

    monitor.startMonitoring(filePath);

    await vi.waitFor(() => {
      expect(onStatusChange).toHaveBeenCalledWith("idle");
      expect(onStatusChange).toHaveBeenCalledWith("working");
      expect(onStatusChange).toHaveBeenCalledWith("awaiting_approval");
      expect(onStatusChange).toHaveBeenCalledWith("awaiting_user_response");
      expect(onStatusChange).toHaveBeenLastCalledWith("awaiting_user_response");
    });

    monitor.stopMonitoring();
  });

  it("ignores shutdown and stream error events for visible status", async () => {
    const filePath = path.join(tempDir, "codex-events.jsonl");
    const onStatusChange = vi.fn();
    const monitor = new CodexActivityMonitor({ onStatusChange });

    monitor.startMonitoring(filePath);

    await appendRaw(
      filePath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        dir: "to_tui",
        kind: "codex_event",
        payload: { msg: { type: "task_started" } },
      })}\n`,
    );

    await vi.waitFor(() => {
      expect(onStatusChange).toHaveBeenCalledWith("working");
    });

    await appendRaw(
      filePath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        dir: "to_tui",
        kind: "codex_event",
        payload: { msg: { type: "stream_error" } },
      })}\n`,
    );
    await appendRaw(
      filePath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        dir: "to_tui",
        kind: "codex_event",
        payload: { msg: { type: "shutdown_complete" } },
      })}\n`,
    );

    await new Promise((resolve) => setTimeout(resolve, 140));
    expect(onStatusChange).toHaveBeenCalledTimes(1);

    monitor.stopMonitoring();
  });

  it("does not emit new events after stopMonitoring", async () => {
    const filePath = path.join(tempDir, "codex-events.jsonl");
    const onStatusChange = vi.fn();
    const monitor = new CodexActivityMonitor({ onStatusChange });

    monitor.startMonitoring(filePath);
    await appendRaw(
      filePath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        dir: "to_tui",
        kind: "codex_event",
        payload: { msg: { type: "task_started" } },
      })}\n`,
    );

    await vi.waitFor(() => {
      expect(onStatusChange).toHaveBeenCalledWith("working");
    });

    monitor.stopMonitoring();
    await appendRaw(
      filePath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        dir: "to_tui",
        kind: "codex_event",
        payload: { msg: { type: "request_user_input" } },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 140));

    expect(onStatusChange).toHaveBeenCalledTimes(2);
    expect(onStatusChange).toHaveBeenLastCalledWith("unknown");
  });
});
