import * as fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateCommitMessagePrompt } from "../../../../src/main/commit-message-generation/prompts";
import { parseCodexTranscript } from "../../../../src/main/session-memory/parsers/codex";
import { parseCursorTranscript } from "../../../../src/main/session-memory/parsers/cursor";
import {
  createTextGenerationRules,
  isTextGenerationConversation,
  resolveHeadlessInstallRoot,
} from "../../../../src/main/session-memory/parsers/text-generation";
import {
  generateTitleGenerationPrompt,
  systemPrompt,
} from "../../../../src/main/title-generation-prompts";
import { makeTempRoot, sourceFor, testContext, writeJsonl } from "./fixtures";

const rules = testContext.textGeneration;

describe("isTextGenerationConversation", () => {
  it("matches the text generation workspace exactly", () => {
    expect(
      isTextGenerationConversation(
        {
          cwd: "/data/agent-ui/text-generation-workspace",
          firstUserText: "hi",
        },
        rules,
      ),
    ).toBe(true);
    expect(
      isTextGenerationConversation(
        {
          cwd: "/data/agent-ui/text-generation-workspace-other",
          firstUserText: "hi",
        },
        rules,
      ),
    ).toBe(false);
  });

  it("matches anything under an install's releases directory", () => {
    expect(
      isTextGenerationConversation(
        {
          cwd: "/install/agent-ui/releases/0.28.0-20260911T104630Z",
          firstUserText: null,
        },
        rules,
      ),
    ).toBe(true);
    expect(
      isTextGenerationConversation(
        { cwd: "/install/agent-ui/current", firstUserText: null },
        rules,
      ),
    ).toBe(false);
  });

  it("matches agent-ui's title and commit prompts in any cwd", () => {
    const titlePrompt = [
      systemPrompt,
      generateTitleGenerationPrompt("fix login"),
    ].join("\n\n");
    expect(
      isTextGenerationConversation(
        { cwd: "/work/app", firstUserText: `\n\n${titlePrompt}` },
        rules,
      ),
    ).toBe(true);
    expect(
      isTextGenerationConversation(
        {
          cwd: "/work/app",
          firstUserText: generateCommitMessagePrompt("diff --git a b"),
        },
        rules,
      ),
    ).toBe(true);
    expect(
      isTextGenerationConversation(
        {
          cwd: "/work/app",
          firstUserText: "Why does the git commit message assistant fail?",
        },
        rules,
      ),
    ).toBe(false);
  });

  it("matches reworded prompts that keep the role line", () => {
    expect(
      isTextGenerationConversation(
        {
          cwd: "/var/tmp/bench",
          firstUserText:
            "You are a summarization assistant. When given a user prompt, summarize it into a very short session title.",
        },
        rules,
      ),
    ).toBe(true);
    expect(
      isTextGenerationConversation(
        {
          cwd: "/var/tmp/bench",
          firstUserText:
            "You are a git commit message assistant. Given a git diff, write a commit message.",
        },
        rules,
      ),
    ).toBe(true);
  });
});

describe("createTextGenerationRules", () => {
  it("derives the workspace and releases directories", () => {
    expect(
      createTextGenerationRules({
        userDataPath: "/data/agent-ui",
        installRoots: ["/install/agent-ui"],
      }),
    ).toEqual(rules);
  });

  it("resolves the headless install root like the install scripts", () => {
    expect(resolveHeadlessInstallRoot({ env: {}, homeDir: "/home/me" })).toBe(
      "/home/me/.local/share/agent-ui",
    );
    expect(
      resolveHeadlessInstallRoot({
        env: { XDG_DATA_HOME: "/xdg" },
        homeDir: "/home/me",
      }),
    ).toBe("/xdg/agent-ui");
    expect(
      resolveHeadlessInstallRoot({
        env: { AGENT_UI_INSTALL_DIR: "/opt/agent-ui", XDG_DATA_HOME: "/xdg" },
        homeDir: "/home/me",
      }),
    ).toBe("/opt/agent-ui");
  });
});

describe("parser origin", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempRoot("text-generation-");
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("flags a Codex commit message run", async () => {
    const filePath = await writeJsonl(path.join(root, "rollout-commit.jsonl"), [
      {
        timestamp: "2026-09-01T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "thr-1", cwd: "/work/app" },
      },
      {
        timestamp: "2026-09-01T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: generateCommitMessagePrompt("diff") },
          ],
        },
      },
    ]);
    const outcome = await parseCodexTranscript(
      await sourceFor("codex", filePath),
      testContext,
    );
    expect(outcome.conversation?.origin).toBe("text-generation");
  });

  it("flags an old packaged Cursor run by its project directory when meta.json is gone", async () => {
    const filePath = await writeJsonl(
      path.join(
        root,
        "projects",
        "install-agent-ui-releases-0-28-0-2026080-125efd0",
        "agent-transcripts",
        "chat-1",
        "chat-1.jsonl",
      ),
      [
        {
          role: "user",
          message: {
            content: [
              { type: "text", text: "<user_query>Summarize</user_query>" },
            ],
          },
        },
        {
          role: "assistant",
          message: { content: [{ type: "text", text: "Short title" }] },
        },
      ],
    );
    const outcome = await parseCursorTranscript(
      await sourceFor("cursor", filePath),
      testContext,
    );
    expect(outcome.conversation?.origin).toBe("text-generation");
  });
});
