import * as fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanCodexUserContent,
  parseCodexTranscript,
} from "../../../../src/main/session-memory/parsers/codex";
import { makeTempRoot, sourceFor, testContext, writeJsonl } from "./fixtures";

const THREAD_ID = "019f0000-0000-7000-8000-000000000001";

let root: string;

beforeEach(async () => {
  root = await makeTempRoot("codex-parser-");
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

function at(offsetMs: number): string {
  return new Date(
    Date.parse("2026-09-01T10:00:00.000Z") + offsetMs,
  ).toISOString();
}

function line(
  offsetMs: number,
  type: string,
  payload: Record<string, unknown>,
) {
  return { timestamp: at(offsetMs), type, payload };
}

function message(offsetMs: number, role: string, items: [string, string][]) {
  return line(offsetMs, "response_item", {
    type: "message",
    role,
    content: items.map(([type, text]) => ({ type, text })),
  });
}

const userMessage = (offsetMs: number, ...texts: string[]) =>
  message(
    offsetMs,
    "user",
    texts.map((text) => ["input_text", text]),
  );
const assistantMessage = (offsetMs: number, text: string) =>
  message(offsetMs, "assistant", [["output_text", text]]);

function sessionMeta(offsetMs: number, payload: Record<string, unknown>) {
  return line(offsetMs, "session_meta", {
    cwd: "/work/api",
    source: "vscode",
    ...payload,
  });
}

async function rollout(name: string, lines: unknown[]): Promise<string> {
  return await writeJsonl(path.join(root, "2026", "09", "01", name), lines);
}

describe("parseCodexTranscript", () => {
  it("builds turns from response items, tools, and rollbacks", async () => {
    const execInput = [
      'const r = await tools.exec_command({cmd:"rg -n \\"health\\" src",max_output_tokens:2000});',
      'text(await tools.apply_patch("*** Begin Patch\\n*** Add File: /work/api/src/health.ts\\n+export {}\\n*** End Patch"));',
    ].join("\n");
    const filePath = await rollout(
      `rollout-2026-09-01T10-00-00-${THREAD_ID}.jsonl`,
      [
        sessionMeta(0, {
          id: THREAD_ID,
          git: { branch: "feat/health", commit_hash: "abc123" },
        }),
        message(1, "developer", [
          [
            "input_text",
            "<permissions instructions>sandbox</permissions instructions>",
          ],
        ]),
        userMessage(
          2,
          "# AGENTS.md instructions for /work/api\n\n<INSTRUCTIONS>be nice</INSTRUCTIONS>",
          "<environment_context>\n  <cwd>/work/api</cwd>\n</environment_context>",
        ),
        line(3, "turn_context", {
          turn_id: "turn-1",
          cwd: "/work/api",
          model: "gpt-5",
        }),
        userMessage(
          4,
          '<image name=[Image #1] path="/tmp/a.png">',
          "</image>",
          "Add a health endpoint",
        ),
        line(5, "event_msg", {
          type: "user_message",
          message: "Add a health endpoint",
        }),
        line(6, "response_item", {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "hidden" }],
        }),
        assistantMessage(7, "I'll add it."),
        line(8, "response_item", {
          type: "custom_tool_call",
          name: "exec",
          call_id: "c1",
          input: execInput,
        }),
        line(9, "response_item", {
          type: "custom_tool_call_output",
          call_id: "c1",
          output: "secret output",
        }),
        line(10, "response_item", {
          type: "function_call",
          name: "exec_command",
          call_id: "c2",
          arguments: JSON.stringify({ cmd: "pnpm test" }),
        }),
        line(11, "response_item", {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "c3",
          input:
            "*** Begin Patch\n*** Update File: /work/api/src/app.ts\n*** Move to: /work/api/src/server.ts\n@@\n-a\n+b\n*** End Patch\n",
        }),
        line(12, "event_msg", {
          type: "patch_apply_end",
          success: true,
          changes: { "/work/api/src/routes.ts": { type: "update" } },
        }),
        assistantMessage(13, "Done."),
        line(14, "turn_context", { turn_id: "turn-2", cwd: "/work/api" }),
        userMessage(15, "<skill>\n<name>fast</name>\nbody\n</skill>"),
        userMessage(16, "Make it faster"),
        assistantMessage(17, "Working."),
        line(18, "event_msg", { type: "thread_rolled_back", num_turns: 1 }),
        line(19, "turn_context", { turn_id: "turn-3", cwd: "/work/api" }),
        userMessage(20, "Make it async"),
        assistantMessage(21, "Made async."),
        line(22, "compacted", { message: "", replacement_history: [] }),
        line(23, "response_item", {
          type: "local_shell_call",
          action: { type: "exec", command: ["bash", "-lc", "ls -la"] },
        }),
        line(24, "mystery_line", {}),
        line(25, "response_item", { type: "new_item_kind" }),
        '{"timestamp": "broken',
      ],
    );

    const outcome = await parseCodexTranscript(
      await sourceFor("codex", filePath),
      testContext,
    );

    expect(outcome.diagnostics).toMatchObject({
      malformedLines: 1,
      unknownLineTypes: { mystery_line: 1, "response_item.new_item_kind": 1 },
    });
    expect(outcome.conversation).toMatchObject({
      agent: "codex",
      nativeId: THREAD_ID,
      cwd: "/work/api",
      gitBranch: "feat/health",
      gitSha: "abc123",
      relation: "main",
      parentNativeId: null,
      origin: "user",
      startedAtMs: Date.parse(at(0)),
      updatedAtMs: Date.parse(at(25)),
    });
    expect(outcome.conversation?.turns).toEqual([
      {
        ordinal: 0,
        startedAtMs: Date.parse(at(4)),
        userText: "Add a health endpoint",
        assistantText: "I'll add it.\n\nDone.",
        filePaths: [
          "/work/api/src/health.ts",
          "/work/api/src/app.ts",
          "/work/api/src/server.ts",
          "/work/api/src/routes.ts",
        ],
        commands: ['rg -n "health" src', "pnpm test"],
        sourceRef: { line: 5, eventId: "turn-1" },
      },
      {
        ordinal: 1,
        startedAtMs: Date.parse(at(20)),
        userText: "Make it async",
        assistantText: "Made async.",
        filePaths: [],
        commands: ["ls -la"],
        sourceRef: { line: 21, eventId: "turn-3" },
      },
    ]);
  });

  it("skips the parent history copied into a fork", async () => {
    const filePath = await rollout("rollout-fork.jsonl", [
      sessionMeta(0, { id: "fork-1", forked_from_id: THREAD_ID }),
      sessionMeta(1, { id: THREAD_ID }),
      userMessage(1, "Add a health endpoint"),
      assistantMessage(2, "Done."),
      userMessage(5000, "Explain the endpoint"),
      assistantMessage(6000, "It returns ok."),
    ]);

    const outcome = await parseCodexTranscript(
      await sourceFor("codex", filePath),
      testContext,
    );
    expect(outcome.conversation).toMatchObject({
      nativeId: "fork-1",
      relation: "fork",
      parentNativeId: THREAD_ID,
      turns: [
        { userText: "Explain the endpoint", assistantText: "It returns ok." },
      ],
    });
  });

  it("marks spawned and review subagents with their parent thread", async () => {
    const spawned = await rollout("rollout-spawn.jsonl", [
      sessionMeta(0, {
        id: "child-1",
        forked_from_id: THREAD_ID,
        source: {
          subagent: { thread_spawn: { parent_thread_id: THREAD_ID, depth: 1 } },
        },
      }),
      userMessage(1, "copied parent prompt"),
      assistantMessage(5000, "Child findings."),
    ]);
    const review = await rollout("rollout-review.jsonl", [
      sessionMeta(0, {
        id: "review-1",
        session_id: THREAD_ID,
        parent_thread_id: THREAD_ID,
        source: { subagent: "review" },
      }),
      userMessage(1, "Review the current code changes"),
      assistantMessage(2, '{"findings": []}'),
    ]);

    const spawnedOutcome = await parseCodexTranscript(
      await sourceFor("codex", spawned),
      testContext,
    );
    expect(spawnedOutcome.conversation).toMatchObject({
      nativeId: "child-1",
      relation: "subagent",
      parentNativeId: THREAD_ID,
      turns: [{ userText: "", assistantText: "Child findings." }],
    });

    const reviewOutcome = await parseCodexTranscript(
      await sourceFor("codex", review),
      testContext,
    );
    expect(reviewOutcome.conversation).toMatchObject({
      nativeId: "review-1",
      relation: "subagent",
      parentNativeId: THREAD_ID,
      turns: [{ userText: "Review the current code changes" }],
    });
  });

  it("falls back to the thread id in the file name", async () => {
    const filePath = await rollout(
      `rollout-2026-09-01T10-00-00-${THREAD_ID}.jsonl`,
      [userMessage(0, "hello")],
    );
    const outcome = await parseCodexTranscript(
      await sourceFor("codex", filePath),
      testContext,
    );
    expect(outcome.conversation?.nativeId).toBe(THREAD_ID);
  });
});

describe("cleanCodexUserContent", () => {
  it("drops injected items and keeps typed text", () => {
    expect(
      cleanCodexUserContent([
        {
          type: "input_text",
          text: "<user_action>\n<context>review</context>\n</user_action>",
        },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        {
          type: "input_text",
          text: "Fix the <turn_aborted>x</turn_aborted>bug",
        },
      ]),
    ).toBe("Fix the bug");
  });
});
