import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStateFileManager } from "../../src/main/session-state-file-manager";
import {
  buildRalphLoopPrompt,
  canResumeAutonomousLoop,
  evaluateStopHookOutcome,
  extractTranscriptPathFromStopHook,
  hasCompleteMarkerInAssistantText,
  hasReachedConsecutiveFailureLimit,
  type RalphLoopSessionData,
  RalphLoopSessionsManager,
  readLastAssistantTextFromTranscript,
} from "../../src/main/sessions/ralph-loop.session";
import type { SessionServiceState } from "../../src/main/sessions/state";
import type { ClaudeHookEvent } from "../../src/shared/claude-types";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function writeTranscript(lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ralph-loop-session-"));
  tempDirs.push(dir);
  const transcriptPath = join(dir, `${randomUUID()}.jsonl`);
  await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");
  return transcriptPath;
}

describe("stop hook transcript helpers", () => {
  it("extracts transcript_path from Stop hooks", () => {
    const event: ClaudeHookEvent = {
      timestamp: "2026-02-18T09:31:27.813Z",
      session_id: "session-1",
      hook_event_name: "Stop",
      transcript_path: " /tmp/test.jsonl ",
    };

    expect(extractTranscriptPathFromStopHook(event)).toBe("/tmp/test.jsonl");
  });

  it("returns null for non-Stop hooks or missing transcript path", () => {
    const stopWithoutPath: ClaudeHookEvent = {
      timestamp: "2026-02-18T09:31:27.813Z",
      session_id: "session-1",
      hook_event_name: "Stop",
    };
    const preHook: ClaudeHookEvent = {
      timestamp: "2026-02-18T09:31:27.813Z",
      session_id: "session-1",
      hook_event_name: "PreToolUse",
      transcript_path: "/tmp/test.jsonl",
    };

    expect(extractTranscriptPathFromStopHook(stopWithoutPath)).toBeNull();
    expect(extractTranscriptPathFromStopHook(preHook)).toBeNull();
  });
});

describe("RalphLoopSessionsManager", () => {
  it("renames loop sessions", () => {
    const state: Record<string, RalphLoopSessionData> = {
      "session-1": {
        sessionId: "session-1",
        type: "ralph-loop",
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        status: "stopped",
        title: "Old Loop Name",
        startupConfig: {
          cwd: "/tmp",
          objectivePrompt: "Keep working",
          model: "opus",
          permissionMode: "yolo",
          maxIterations: 5,
          maxConsecutiveFailures: 2,
          backoffInitialMs: 1000,
          backoffMaxMs: 2000,
        },
        loopState: {
          autonomousEnabled: false,
          currentIteration: 0,
          consecutiveFailures: 0,
          completion: "not_done",
          completeDetected: false,
        },
        bufferedOutput: "",
      },
    };

    const manager = new RalphLoopSessionsManager({
      pluginDir: null,
      state: {
        state,
        updateState: (updater: (draft: typeof state) => void) => updater(state),
      } as unknown as SessionServiceState,
      stateFileManager: {
        create: vi.fn(),
        cleanup: vi.fn(),
      } as unknown as SessionStateFileManager,
    });

    manager.renameSession("session-1", "  New Loop Name  ");

    expect(state["session-1"]?.title).toBe("New Loop Name");
  });
});

describe("assistant transcript parsing", () => {
  it("reads the last assistant entry and joins only text blocks", async () => {
    const transcriptPath = await writeTranscript([
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "older assistant output" }],
        },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "next task" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "line 1" },
            { type: "tool_use", name: "Bash", input: "echo test" },
            { type: "text", text: "line 2" },
          ],
        },
      }),
    ]);

    const result = await readLastAssistantTextFromTranscript(transcriptPath);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.text).toBe("line 1\nline 2");
    }
  });

  it("fails when transcript file is unreadable", async () => {
    const result = await readLastAssistantTextFromTranscript(
      `/tmp/does-not-exist-${randomUUID()}.jsonl`,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Failed reading transcript file");
    }
  });

  it("fails when transcript contains invalid JSONL", async () => {
    const transcriptPath = await writeTranscript([
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "valid line" }] },
      }),
      "{this-is-invalid-jsonl}",
    ]);

    const result = await readLastAssistantTextFromTranscript(transcriptPath);
    expect(result).toEqual({
      success: false,
      error: "Transcript contains invalid JSONL.",
    });
  });

  it("fails when no assistant entry exists", async () => {
    const transcriptPath = await writeTranscript([
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
    ]);

    const result = await readLastAssistantTextFromTranscript(transcriptPath);
    expect(result).toEqual({
      success: false,
      error: "No assistant entry found in transcript.",
    });
  });
});

describe("completion marker detection", () => {
  it("matches <COMPLETE/> at any position", () => {
    expect(hasCompleteMarkerInAssistantText("done\n<COMPLETE/>")).toBe(true);
    expect(hasCompleteMarkerInAssistantText("prefix <complete/> suffix")).toBe(
      true,
    );
    expect(
      hasCompleteMarkerInAssistantText("prefix < COMPLETE /> suffix"),
    ).toBe(true);
  });

  it("ignores non-matching text", () => {
    expect(hasCompleteMarkerInAssistantText("work in progress")).toBe(false);
    expect(hasCompleteMarkerInAssistantText("<COMPLETE>")).toBe(false);
  });
});

describe("stop hook outcome evaluation", () => {
  it("does nothing when Stop hook was not observed", async () => {
    const result = await evaluateStopHookOutcome({
      stopHookSeen: false,
    });

    expect(result).toEqual({
      completeDetected: false,
      transcriptReadFailed: false,
    });
  });

  it("fails when Stop hook has no transcript path", async () => {
    const result = await evaluateStopHookOutcome({
      stopHookSeen: true,
    });

    expect(result).toEqual({
      completeDetected: false,
      transcriptReadFailed: true,
      transcriptReadError:
        "Stop hook event missing transcript_path; cannot evaluate completion marker.",
    });
  });

  it("detects completion marker by reading transcript at evaluation time", async () => {
    const transcriptPath = await writeTranscript([
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "done <COMPLETE/>" }] },
      }),
    ]);

    const result = await evaluateStopHookOutcome({
      stopHookSeen: true,
      stopHookTranscriptPath: transcriptPath,
    });

    expect(result).toEqual({
      completeDetected: true,
      transcriptReadFailed: false,
    });
  });
});

describe("failure cutoff boundary", () => {
  it("treats the configured cap as inclusive", () => {
    expect(hasReachedConsecutiveFailureLimit(2, 3)).toBe(false);
    expect(hasReachedConsecutiveFailureLimit(3, 3)).toBe(true);
    expect(hasReachedConsecutiveFailureLimit(4, 3)).toBe(true);
  });
});

describe("resume guard for terminal completions", () => {
  it("blocks autonomous resume for done/max_iterations only", () => {
    expect(canResumeAutonomousLoop("done")).toBe(false);
    expect(canResumeAutonomousLoop("max_iterations")).toBe(false);
    expect(canResumeAutonomousLoop("not_done")).toBe(true);
    expect(canResumeAutonomousLoop("stopped_by_user")).toBe(true);
    expect(canResumeAutonomousLoop("error")).toBe(true);
  });
});

describe("ralph-loop prompt builder", () => {
  it("expands iteration and COMPLETE placeholders from objective prompt", () => {
    const prompt = buildRalphLoopPrompt({
      objectivePrompt: "Iteration: {iteration}\nReturn {complete_marker}",
      iteration: 3,
    });

    expect(prompt).toContain("Iteration: 3");
    expect(prompt).toContain("<COMPLETE/>");
  });

  it("does not include legacy JSON marker instructions", () => {
    const prompt = buildRalphLoopPrompt({
      objectivePrompt: "Test",
      iteration: 1,
    });

    expect(prompt).not.toContain("RALPH_LOOP_STATUS");
    expect(prompt).not.toContain('"state"');
  });
});
