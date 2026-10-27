import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeActivityMonitor } from "../../src/main/claude-activity-monitor";
import type { ClaudeHookEvent } from "../../src/shared/claude-types";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function appendRaw(filePath: string, value: string): Promise<void> {
  await writeFile(filePath, value, { encoding: "utf8", flag: "a" });
}

describe("ClaudeActivityMonitor", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "claude-activity-monitor-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("reads existing hook events when monitoring starts", async () => {
    const filePath = path.join(tempDir, "events.ndjson");
    const event: ClaudeHookEvent = {
      timestamp: new Date().toISOString(),
      session_id: "session-1",
      hook_event_name: "SessionStart",
    };
    await writeFile(filePath, `${JSON.stringify(event)}\n`, "utf8");

    const onStatusChange = vi.fn();
    const onHookEvent = vi.fn();
    const monitor = new ClaudeActivityMonitor({
      onStatusChange,
      onHookEvent,
    });

    monitor.startMonitoring(filePath);

    await vi.waitFor(() => {
      expect(onHookEvent).toHaveBeenCalledWith(event);
      expect(onStatusChange).toHaveBeenCalledWith("idle");
    });
    monitor.stopMonitoring();
  });

  it("does not emit new events after stopMonitoring", async () => {
    const filePath = path.join(tempDir, "events.ndjson");
    const onStatusChange = vi.fn();
    const onHookEvent = vi.fn();
    const monitor = new ClaudeActivityMonitor({
      onStatusChange,
      onHookEvent,
    });

    monitor.startMonitoring(filePath);
    await appendRaw(
      filePath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        session_id: "session-1",
        hook_event_name: "UserPromptSubmit",
      })}\n`,
    );

    await vi.waitFor(() => {
      expect(onHookEvent).toHaveBeenCalledTimes(1);
    });

    monitor.stopMonitoring();
    await appendRaw(
      filePath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        session_id: "session-1",
        hook_event_name: "PermissionRequest",
      })}\n`,
    );
    await sleep(150);

    expect(onHookEvent).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenCalledWith("unknown");
  });

  describe("subagents", () => {
    async function collectStatuses(
      events: Array<Partial<ClaudeHookEvent>>,
    ): Promise<string[]> {
      const filePath = path.join(tempDir, "events.ndjson");
      await writeFile(
        filePath,
        events
          .map((event) =>
            JSON.stringify({
              timestamp: new Date().toISOString(),
              session_id: "session-1",
              ...event,
            }),
          )
          .join("\n")
          .concat("\n"),
        "utf8",
      );

      const onHookEvent = vi.fn();
      const statuses: string[] = [];
      const monitor = new ClaudeActivityMonitor({
        onStatusChange: (status) => statuses.push(status),
        onHookEvent,
      });
      monitor.startMonitoring(filePath);
      await vi.waitFor(() => {
        expect(onHookEvent).toHaveBeenCalledTimes(events.length);
      });
      monitor.stopMonitoring();
      return statuses.slice(0, -1);
    }

    it("stays working while a background subagent runs after Stop", async () => {
      const statuses = await collectStatuses([
        { hook_event_name: "UserPromptSubmit" },
        { hook_event_name: "SubagentStart", agent_id: "agent-1" },
        {
          hook_event_name: "Stop",
          background_tasks: [{ id: "agent-1", type: "subagent" }],
        },
        { hook_event_name: "Notification", notification_type: "idle_prompt" },
        { hook_event_name: "PreToolUse", agent_id: "agent-1" },
        { hook_event_name: "SubagentStop", agent_id: "agent-1" },
      ]);

      expect(statuses).toEqual(["working", "awaiting_user_response"]);
    });

    it("reconciles running subagents from background tasks on Stop", async () => {
      const statuses = await collectStatuses([
        { hook_event_name: "UserPromptSubmit" },
        { hook_event_name: "SubagentStart", agent_id: "agent-1" },
        {
          hook_event_name: "Stop",
          background_tasks: [{ id: "shell-1", type: "shell" }],
        },
        { hook_event_name: "UserPromptSubmit" },
        {
          hook_event_name: "Stop",
          background_tasks: [{ id: "agent-2", type: "subagent" }],
        },
      ]);

      expect(statuses).toEqual([
        "working",
        "awaiting_user_response",
        "working",
      ]);
    });

    it("tracks approvals requested by background subagents", async () => {
      const statuses = await collectStatuses([
        { hook_event_name: "UserPromptSubmit" },
        { hook_event_name: "SubagentStart", agent_id: "agent-1" },
        { hook_event_name: "SubagentStart", agent_id: "agent-2" },
        { hook_event_name: "Stop" },
        { hook_event_name: "PermissionRequest", agent_id: "agent-1" },
        {
          hook_event_name: "Notification",
          notification_type: "permission_prompt",
        },
        { hook_event_name: "PreToolUse", agent_id: "agent-2" },
        { hook_event_name: "PreToolUse", agent_id: "agent-1" },
        { hook_event_name: "SubagentStop", agent_id: "agent-1" },
        { hook_event_name: "SubagentStop", agent_id: "agent-2" },
      ]);

      expect(statuses).toEqual([
        "working",
        "awaiting_approval",
        "working",
        "awaiting_user_response",
      ]);
    });
  });
});
