import * as fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanClaudeUserText,
  parseClaudeTranscript,
} from "../../../../src/main/session-memory/parsers/claude";
import {
  makeTempRoot,
  sourceFor,
  testContext,
  writeJson,
  writeJsonl,
} from "./fixtures";

let root: string;

beforeEach(async () => {
  root = await makeTempRoot("claude-parser-");
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

let clock = Date.parse("2026-09-01T10:00:00.000Z");

function base(uuid: string, parentUuid: string | null) {
  clock += 1000;
  return {
    uuid,
    parentUuid,
    isSidechain: false,
    sessionId: "sess-1",
    cwd: "/work/app",
    gitBranch: "main",
    timestamp: new Date(clock).toISOString(),
  };
}

function user(
  uuid: string,
  parentUuid: string | null,
  content: unknown,
  extra = {},
) {
  return {
    ...base(uuid, parentUuid),
    type: "user",
    message: { role: "user", content },
    ...extra,
  };
}

function assistant(
  uuid: string,
  parentUuid: string | null,
  content: unknown[],
  extra = {},
) {
  return {
    ...base(uuid, parentUuid),
    type: "assistant",
    message: { role: "assistant", model: "claude-opus-5", content },
    ...extra,
  };
}

const text = (value: string) => ({ type: "text", text: value });
const toolUse = (name: string, input: Record<string, unknown>) => ({
  type: "tool_use",
  id: `toolu_${name}`,
  name,
  input,
});
const toolResult = (content: string) => ({
  type: "tool_result",
  tool_use_id: "toolu_x",
  content,
});

describe("parseClaudeTranscript", () => {
  it("groups turns on the active branch and strips injected context", async () => {
    const filePath = await writeJsonl(
      path.join(root, "-work-app", "sess-1.jsonl"),
      [
        {
          type: "permission-mode",
          permissionMode: "default",
          sessionId: "sess-1",
        },
        user(
          "u1",
          null,
          "Fix the login bug<system-reminder>ignore me</system-reminder>",
        ),
        {
          ...base("a1", "u1"),
          type: "attachment",
          attachment: { type: "date" },
        },
        assistant("as1", "a1", [
          { type: "thinking", thinking: "hidden" },
          text("Looking at auth."),
        ]),
        assistant("as2", "as1", [
          toolUse("Read", { file_path: "/work/app/auth.ts" }),
        ]),
        user("tr1", "as2", [toolResult("secret file contents")]),
        assistant("as3", "tr1", [
          toolUse("Bash", { command: "pnpm test", description: "Run tests" }),
        ]),
        user("tr2", "as3", [toolResult("tests passed")]),
        assistant("as4", "tr2", [text("Fixed it.")]),
        { ...base("s1", "as4"), type: "system", subtype: "turn_duration" },
        user("m1", "s1", "Skill body that Claude injected", { isMeta: true }),
        user(
          "u2",
          "m1",
          "<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>auth module</command-args>",
        ),
        assistant("as5", "u2", [text("Review: fine.")]),
        user("u3", "as5", "abandoned question"),
        assistant("as6", "u3", [text("abandoned answer")]),
        user("u4", "as5", "better question"),
        assistant("as7", "u4", [
          text("better answer"),
          toolUse("Edit", {
            file_path: "/work/app/auth.ts",
            old_string: "a",
            new_string: "b",
          }),
          toolUse("Write", { file_path: "/work/app/new.ts", content: "x" }),
        ]),
        user("u5", "as7", [text("[Request interrupted by user]")]),
        {
          ...base("c1", null),
          type: "system",
          subtype: "compact_boundary",
          logicalParentUuid: "u5",
        },
        user(
          "cs1",
          "c1",
          "This session is being continued from a previous conversation.",
          {
            isCompactSummary: true,
          },
        ),
        user(
          "u6",
          "cs1",
          "<local-command-stdout>Compacted</local-command-stdout>",
        ),
        {
          ...base("q1", "u6"),
          type: "attachment",
          attachment: {
            type: "queued_command",
            prompt: "what's the status?",
            commandMode: "prompt",
            origin: { kind: "human" },
          },
        },
        {
          ...base("q2", "q1"),
          type: "attachment",
          attachment: {
            type: "queued_command",
            prompt:
              "<task-notification><status>completed</status></task-notification>",
            commandMode: "task-notification",
          },
        },
        assistant("as8", "q2", [text("Status: green.")]),
        "{not json",
        { type: "mystery", sessionId: "sess-1" },
        user("side1", "as8", "sidechain prompt", { isSidechain: true }),
        assistant("syn1", "as8", [text("No response requested.")], {
          message: {
            role: "assistant",
            model: "<synthetic>",
            content: [text("No response requested.")],
          },
        }),
        { type: "custom-title", customTitle: "Login fix", sessionId: "sess-1" },
      ],
    );

    const outcome = await parseClaudeTranscript(
      await sourceFor("claude", filePath),
      testContext,
    );
    const conversation = outcome.conversation;

    expect(outcome.diagnostics).toMatchObject({
      malformedLines: 1,
      unknownLineTypes: { mystery: 1 },
      readError: null,
    });
    expect(conversation).toMatchObject({
      agent: "claude",
      nativeId: "sess-1",
      cwd: "/work/app",
      gitBranch: "main",
      title: "Login fix",
      relation: "main",
      parentNativeId: null,
      origin: "user",
    });
    expect(
      conversation?.turns.map((turn) => ({
        user: turn.userText,
        assistant: turn.assistantText,
        files: turn.filePaths,
        commands: turn.commands,
      })),
    ).toEqual([
      {
        user: "Fix the login bug",
        assistant: "Looking at auth.\n\nFixed it.",
        files: ["/work/app/auth.ts"],
        commands: ["pnpm test"],
      },
      {
        user: "/review auth module",
        assistant: "Review: fine.",
        files: [],
        commands: [],
      },
      {
        user: "better question",
        assistant: "better answer",
        files: ["/work/app/auth.ts", "/work/app/new.ts"],
        commands: [],
      },
      {
        user: "what's the status?",
        assistant: "Status: green.",
        files: [],
        commands: [],
      },
    ]);
    expect(conversation?.turns[0]).toMatchObject({
      ordinal: 0,
      sourceRef: { line: 2, eventId: "u1" },
    });
    expect(conversation?.turns[3]?.ordinal).toBe(3);
    expect(conversation?.startedAtMs).toBeLessThan(
      conversation?.updatedAtMs ?? 0,
    );
  });

  it("keeps everything before a parent link that points outside the file", async () => {
    const filePath = await writeJsonl(
      path.join(root, "-work-app", "sess-2.jsonl"),
      [
        user("u1", null, "first question"),
        assistant("as1", "u1", [text("first answer")]),
        user("u2", "missing-parent", "second question"),
        assistant("as2", "u2", [text("second answer")]),
      ],
    );

    const outcome = await parseClaudeTranscript(
      await sourceFor("claude", filePath),
      testContext,
    );
    expect(outcome.conversation?.turns.map((turn) => turn.userText)).toEqual([
      "first question",
      "second question",
    ]);
  });

  it("links a subagent transcript to its parent session", async () => {
    const dir = path.join(root, "-work-app", "sess-1", "subagents");
    const filePath = await writeJsonl(path.join(dir, "agent-abc123.jsonl"), [
      {
        type: "fork-context-ref",
        agentId: "abc123",
        parentSessionId: "sess-1",
      },
      user(
        "u1",
        null,
        [
          toolResult("parent output"),
          text(
            "<fork-boilerplate>\nYou are a worker fork.\n</fork-boilerplate>\n\nYour directive: scan the repo",
          ),
        ],
        { isSidechain: true, agentId: "abc123" },
      ),
      assistant("as1", "u1", [text("Scanned.")], { isSidechain: true }),
    ]);
    const metaPath = await writeJson(path.join(dir, "agent-abc123.meta.json"), {
      agentType: "fork",
      description: "Scan the repo",
    });

    const outcome = await parseClaudeTranscript(
      await sourceFor("claude", filePath, metaPath),
      testContext,
    );
    expect(outcome.conversation).toMatchObject({
      nativeId: "abc123",
      parentNativeId: "sess-1",
      relation: "subagent",
      title: "Scan the repo",
      turns: [
        {
          userText: "Your directive: scan the repo",
          assistantText: "Scanned.",
        },
      ],
    });
  });

  describe("forks", () => {
    const header = (sessionId: string) => [
      { type: "permission-mode", permissionMode: "default", sessionId },
      { type: "file-history-snapshot", messageId: "u1", snapshot: {} },
    ];
    const bookkeeping = (sessionId: string) => ({
      type: "last-prompt",
      leafUuid: "x",
      sessionId,
    });

    async function writeForkFamily() {
      const dir = path.join(root, "-work-app");
      const firstTurn = [
        user("u1", null, "first question"),
        assistant("as1", "u1", [text("first answer")]),
      ];
      const secondTurn = [
        user("u2", "as1", "second question"),
        assistant("as2", "u2", [text("second answer")]),
      ];
      const forkTurn = [
        user("u3", "as2", "fork question"),
        assistant("as3", "u3", [text("fork answer")]),
      ];
      const parent = await writeJsonl(path.join(dir, "parent.jsonl"), [
        ...header("parent"),
        ...firstTurn,
        bookkeeping("parent"),
        ...secondTurn,
        bookkeeping("parent"),
        user("u9", "as2", "parent continues"),
      ]);
      const fork = await writeJsonl(path.join(dir, "fork.jsonl"), [
        ...header("fork"),
        ...firstTurn,
        ...secondTurn,
        ...forkTurn,
        bookkeeping("fork"),
        user("u4", "as3", "fork continues"),
      ]);
      const nested = await writeJsonl(path.join(dir, "nested.jsonl"), [
        ...header("nested"),
        ...firstTurn,
        ...secondTurn,
        ...forkTurn,
        user("u5", "as3", "nested question"),
        bookkeeping("nested"),
      ]);
      return { parent, fork, nested };
    }

    async function parse(filePath: string) {
      return (
        await parseClaudeTranscript(
          await sourceFor("claude", filePath),
          testContext,
        )
      ).conversation;
    }

    it("drops history copied by --fork-session and links the parent", async () => {
      const { parent, fork, nested } = await writeForkFamily();

      expect(await parse(parent)).toMatchObject({
        relation: "main",
        parentNativeId: null,
        turns: [
          { userText: "first question" },
          { userText: "second question" },
          { userText: "parent continues" },
        ],
      });

      const forked = await parse(fork);
      expect(forked).toMatchObject({
        nativeId: "fork",
        relation: "fork",
        parentNativeId: "parent",
        turns: [
          { ordinal: 0, userText: "fork question" },
          { ordinal: 1, userText: "fork continues" },
        ],
      });
      expect(forked?.startedAtMs).toBe(forked?.turns[0]?.startedAtMs);

      expect(await parse(nested)).toMatchObject({
        relation: "fork",
        parentNativeId: "fork",
        turns: [{ userText: "nested question" }],
      });
    });

    it("keeps sessions that only share a directory", async () => {
      const dir = path.join(root, "-work-app");
      await writeJsonl(path.join(dir, "other.jsonl"), [
        user("o1", null, "other question"),
        bookkeeping("other"),
      ]);
      const filePath = await writeJsonl(path.join(dir, "solo.jsonl"), [
        user("s1", null, "solo question"),
        assistant("sa1", "s1", [text("solo answer")]),
        user("s2", "sa1", "solo follow-up"),
      ]);

      expect(await parse(filePath)).toMatchObject({
        relation: "main",
        parentNativeId: null,
        turns: [{ userText: "solo question" }, { userText: "solo follow-up" }],
      });
    });

    it("uses forkedFrom markers written by /branch", async () => {
      const forkedFrom = (messageUuid: string) => ({
        forkedFrom: { sessionId: "gone", messageUuid },
      });
      const filePath = await writeJsonl(
        path.join(root, "-work-app", "branch.jsonl"),
        [
          user("b1", null, "copied question", forkedFrom("b1")),
          assistant("ba1", "b1", [text("copied answer")], forkedFrom("ba1")),
          user("b2", "ba1", "branch question"),
        ],
      );

      expect(await parse(filePath)).toMatchObject({
        relation: "fork",
        parentNativeId: "gone",
        turns: [{ userText: "branch question" }],
      });
    });
  });

  it("reports an unreadable file without throwing", async () => {
    const outcome = await parseClaudeTranscript(
      {
        agent: "claude",
        path: path.join(root, "missing.jsonl"),
        size: 0,
        mtimeMs: 0,
        metaPath: null,
        metaMtimeMs: null,
        fingerprint: "",
      },
      testContext,
    );
    expect(outcome.conversation).toBeNull();
    expect(outcome.diagnostics.readError).toEqual(expect.any(String));
  });
});

describe("cleanClaudeUserText", () => {
  it("keeps the slash command and its arguments", () => {
    expect(
      cleanClaudeUserText(
        "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>",
      ),
    ).toBe("/compact");
  });

  it("drops harness notifications entirely", () => {
    expect(
      cleanClaudeUserText(
        "<task-notification>\n<task-id>a1</task-id>\n<summary>Agent finished</summary>\n</task-notification>",
      ),
    ).toBe("");
  });

  it("keeps bash-mode input but not its output", () => {
    expect(
      cleanClaudeUserText(
        "<bash-input>ls</bash-input><bash-stdout>secret</bash-stdout>",
      ),
    ).toBe("! ls");
  });
});
