import * as fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanCursorUserText,
  cursorProjectSlug,
  parseCursorTranscript,
} from "../../../../src/main/session-memory/parsers/cursor";
import {
  makeTempRoot,
  sourceFor,
  testContext,
  writeJson,
  writeJsonl,
} from "./fixtures";

let root: string;

beforeEach(async () => {
  root = await makeTempRoot("cursor-parser-");
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const user = (text: string) => ({
  role: "user",
  message: { content: [{ type: "text", text }] },
});
const assistant = (...content: unknown[]) => ({
  role: "assistant",
  message: { content },
});
const text = (value: string) => ({ type: "text", text: value });
const toolUse = (name: string, input: unknown) => ({
  type: "tool_use",
  name,
  input,
});

async function transcript(
  projectSlug: string,
  chatId: string,
  lines: unknown[],
): Promise<string> {
  return await writeJsonl(
    path.join(
      root,
      "projects",
      projectSlug,
      "agent-transcripts",
      chatId,
      `${chatId}.jsonl`,
    ),
    lines,
  );
}

describe("parseCursorTranscript", () => {
  it("unwraps queries, joins chat metadata, and collects tool inputs", async () => {
    const filePath = await transcript("work-web", "chat-1", [
      user(
        '<dynamic_tool_catalog>\n<namespace name="cursor" />\n</dynamic_tool_catalog>\n<timestamp>Wednesday, Sep 9, 2026, 9:32 AM (UTC)</timestamp>\n<user_query>\nWhy is the build failing?\n</user_query>',
      ),
      assistant(
        text("I'll check.\n\n[REDACTED]"),
        toolUse("Read", { path: "/work/web/vite.config.ts" }),
        toolUse("Shell", { command: "pnpm build", description: "Build" }),
      ),
      assistant(
        toolUse(
          "StrReplace",
          JSON.stringify({
            path: "/work/web/src/a.ts",
            old_string: "a",
            new_string: "b",
          }),
        ),
      ),
      assistant(text("Fixed the config.")),
      { type: "turn_ended", status: "success" },
      user(
        "<manually_attached_skills>\nSkill Name: deploy\nbody\n</manually_attached_skills>\n<timestamp>Wednesday, Sep 9, 2026, 9:40 AM (UTC)</timestamp>\n<user_query>Ship it</user_query>",
      ),
      assistant(text("Shipped.")),
      { type: "weird" },
    ]);
    const metaPath = await writeJson(
      path.join(root, "chats", "abc", "chat-1", "meta.json"),
      {
        schemaVersion: 1,
        cwd: "/work/web",
        title: "Build fix",
        createdAtMs: 1000,
        updatedAtMs: 2000,
        hasConversation: true,
      },
    );

    const outcome = await parseCursorTranscript(
      await sourceFor("cursor", filePath, metaPath),
      testContext,
    );
    expect(outcome.diagnostics.unknownLineTypes).toEqual({ weird: 1 });
    expect(outcome.conversation).toMatchObject({
      agent: "cursor",
      nativeId: "chat-1",
      cwd: "/work/web",
      title: "Build fix",
      startedAtMs: 1000,
      updatedAtMs: 2000,
      relation: "main",
      origin: "user",
    });
    expect(outcome.conversation?.turns).toEqual([
      {
        ordinal: 0,
        startedAtMs: Date.parse("2026-09-09T09:32:00Z"),
        userText: "Why is the build failing?",
        assistantText: "I'll check.\n\nFixed the config.",
        filePaths: ["/work/web/vite.config.ts", "/work/web/src/a.ts"],
        commands: ["pnpm build"],
        sourceRef: { line: 1, eventId: null },
      },
      {
        ordinal: 1,
        startedAtMs: Date.parse("2026-09-09T09:40:00Z"),
        userText: "Ship it",
        assistantText: "Shipped.",
        filePaths: [],
        commands: [],
        sourceRef: { line: 6, eventId: null },
      },
    ]);
  });

  it("falls back to file data when the chat has no meta.json", async () => {
    const filePath = await transcript("work-web", "chat-2", [
      user(
        "<timestamp>Wednesday, Sep 9, 2026, 9:32 AM (UTC)</timestamp>\n<user_query>hi</user_query>",
      ),
      assistant(text("hello")),
    ]);
    const source = await sourceFor("cursor", filePath);

    const outcome = await parseCursorTranscript(source, testContext);
    expect(outcome.conversation).toMatchObject({
      cwd: null,
      title: null,
      startedAtMs: Date.parse("2026-09-09T09:32:00Z"),
      updatedAtMs: source.mtimeMs,
    });
  });
});

describe("cleanCursorUserText", () => {
  it("keeps text without wrapper tags and drops attached command bodies", () => {
    expect(
      cleanCursorUserText(
        "<cursor_commands>\n/deploy body\n</cursor_commands>\nPlain message",
      ),
    ).toEqual({ text: "Plain message", timestampMs: null });
  });
});

describe("cursorProjectSlug", () => {
  it("matches Cursor's project directory names", () => {
    expect(
      cursorProjectSlug("/home/me/.local/share/agent-ui/releases/0.28.0-2026"),
    ).toBe("home-me-local-share-agent-ui-releases-0-28-0-2026");
  });
});
