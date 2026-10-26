import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClaudeProject } from "@shared/claude-types";
import {
  defaultSessionMemoryState,
  type SessionMemorySearchInput,
  type SessionMemoryState,
} from "@shared/session-memory";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../../../src/main/logger", () => ({ default: loggerMocks }));

import { listPastSessions } from "../../../../src/main/mcp/tools/list-past-sessions";
import {
  PastSessionsInputError,
  type PastSessionsServices,
  parseDateBound,
  resolveProjectFilter,
  runPastSessionsTool,
  SESSION_MEMORY_DISABLED_MESSAGE,
  searchCoverageNote,
} from "../../../../src/main/mcp/tools/past-sessions";
import {
  readPastSession,
  truncateMiddle,
} from "../../../../src/main/mcp/tools/read-past-session";
import { searchPastSessions } from "../../../../src/main/mcp/tools/search-past-sessions";
import { renderTurnText } from "../../../../src/main/session-memory/chunking";
import { fakeEmbedding } from "../../../../src/main/session-memory/embedding/fake-embedder";
import { SessionMemoryUnavailableError } from "../../../../src/main/session-memory/embedding-pipeline";
import type {
  ParsedConversation,
  ParsedTurn,
} from "../../../../src/main/session-memory/parsers/types";
import {
  replaceTurnChunks,
  storeChunkVector,
} from "../../../../src/main/session-memory/store/chunks";
import type { SessionMemoryDatabase } from "../../../../src/main/session-memory/store/database";
import { applyParseOutcome } from "../../../../src/main/session-memory/store/index-writer";
import { searchChunks } from "../../../../src/main/session-memory/store/search";
import type { Session } from "../../../../src/main/sessions/state";
import {
  createTempDatabase,
  makeConversation,
  makeSource,
  makeTurn,
  outcomeOf,
} from "../../session-memory/store/fixtures";

const MODEL = "fake-model";
const HOUR = 60 * 60 * 1000;
// 2026-10-12 12:00 in Asia/Tokyo (UTC+9, no DST).
const NOW = Date.UTC(2026, 9, 12, 3, 0);

function tokyo(
  day: number,
  hour = 0,
  minute = 0,
  month = 10,
  year = 2026,
): number {
  return Date.UTC(year, month - 1, day, hour - 9, minute);
}

beforeAll(() => {
  vi.stubEnv("TZ", "Asia/Tokyo");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("parseDateBound", () => {
  it("reads date-only values as local days, inclusive at the end", () => {
    expect(parseDateBound("2026-10-05", "start", NOW)).toBe(tokyo(5));
    expect(parseDateBound("2026-10-05", "end", NOW)).toBe(
      tokyo(5, 23, 59) + 59_999,
    );
  });

  it("reads datetimes without an offset as local time", () => {
    expect(parseDateBound("2026-10-05T14:30", "start", NOW)).toBe(
      tokyo(5, 14, 30),
    );
    expect(parseDateBound("2026-10-05 14:30:15", "end", NOW)).toBe(
      tokyo(5, 14, 30) + 15_000,
    );
  });

  it("honours explicit offsets", () => {
    expect(parseDateBound("2026-10-05T14:30Z", "start", NOW)).toBe(
      Date.UTC(2026, 9, 5, 14, 30),
    );
    expect(parseDateBound("2026-10-05T14:30:00+02:00", "start", NOW)).toBe(
      Date.UTC(2026, 9, 5, 12, 30),
    );
  });

  it("supports today, yesterday and relative ages", () => {
    expect(parseDateBound("today", "start", NOW)).toBe(tokyo(12));
    expect(parseDateBound("Yesterday", "start", NOW)).toBe(tokyo(11));
    expect(parseDateBound("yesterday", "end", NOW)).toBe(tokyo(12) - 1);
    expect(parseDateBound("36h", "start", NOW)).toBe(NOW - 36 * HOUR);
    expect(parseDateBound("7 days ago", "start", NOW)).toBe(
      NOW - 7 * 24 * HOUR,
    );
    expect(parseDateBound("2w", "start", NOW)).toBe(NOW - 14 * 24 * HOUR);
  });

  it("rejects malformed or impossible dates", () => {
    expect(parseDateBound("last week", "start", NOW)).toBeNull();
    expect(parseDateBound("2026-02-30", "start", NOW)).toBeNull();
    expect(parseDateBound("2026-10-05T25:00", "start", NOW)).toBeNull();
    expect(parseDateBound("10/05/2026", "start", NOW)).toBeNull();
  });
});

describe("resolveProjectFilter", () => {
  const projects: ClaudeProject[] = [
    { path: "/work/app", collapsed: false },
    {
      path: "/work/app-feature",
      collapsed: false,
      worktreeOriginPath: "/work/app",
    },
    { path: "/work/site", collapsed: false, alias: "Marketing" },
    { path: "/other/site", collapsed: false },
  ];

  it("maps registered projects to their project path", () => {
    expect(resolveProjectFilter("/work/app/", projects)).toMatchObject({
      projectPath: "/work/app",
    });
    expect(resolveProjectFilter("app", projects)).toMatchObject({
      projectPath: "/work/app",
    });
    expect(resolveProjectFilter("marketing", projects)).toMatchObject({
      projectPath: "/work/site",
    });
  });

  it("matches worktrees and unregistered paths by cwd", () => {
    expect(resolveProjectFilter("/work/app-feature", projects)).toEqual({
      cwdPrefix: "/work/app-feature",
      label: "cwd under /work/app-feature",
    });
    expect(resolveProjectFilter("/tmp/scratch", projects)).toMatchObject({
      cwdPrefix: "/tmp/scratch",
    });
  });

  it("resolves current to the calling session's project, worktrees included", () => {
    expect(resolveProjectFilter("current", projects, "/work/app")).toEqual({
      projectPath: "/work/app",
      label: "current project /work/app",
    });
    expect(
      resolveProjectFilter("current", projects, "/work/app-feature/pkg"),
    ).toMatchObject({ projectPath: "/work/app" });
    expect(
      resolveProjectFilter("Current", projects, "/tmp/scratch"),
    ).toMatchObject({ cwdPrefix: "/tmp/scratch" });
    expect(() => resolveProjectFilter("current", projects, null)).toThrow(
      /only works from an Agent UI session/,
    );
  });

  it("rejects ambiguous and unknown names with guidance", () => {
    expect(() => resolveProjectFilter("site", projects)).toThrow(
      /ambiguous.*\/other\/site/,
    );
    expect(() => resolveProjectFilter("nope", projects)).toThrow(
      /Known projects: app, Marketing, site/,
    );
  });
});

describe("truncateMiddle", () => {
  it("keeps the head and the tail within the budget", () => {
    const text = `${"a".repeat(500)}${"b".repeat(500)}`;
    const result = truncateMiddle(text, 200);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.startsWith("aaa")).toBe(true);
    expect(result.endsWith("bbb")).toBe(true);
    expect(result).toContain("chars omitted");
    expect(truncateMiddle("short", 200)).toBe("short");
  });
});

describe("past session tools", () => {
  let database: SessionMemoryDatabase;
  let cleanup: () => Promise<void>;
  let sourceDir: string;
  let state: SessionMemoryState;
  let enabled: boolean;
  let sessions: Record<string, Session>;
  let services: PastSessionsServices;
  let searchCalls: SessionMemorySearchInput[];

  const projects: ClaudeProject[] = [
    { path: "/work/app", collapsed: false },
    { path: "/work/site", collapsed: false },
  ];

  async function addConversation(
    nativeId: string,
    options: {
      overrides?: Partial<ParsedConversation>;
      turns: ParsedTurn[];
      projectPath?: string | null;
      agentUiSessionId?: string | null;
      sourcePath?: string;
    },
  ): Promise<number> {
    const agent = options.overrides?.agent ?? "claude";
    const source = makeSource(
      agent,
      options.sourcePath ?? path.join(sourceDir, `${nativeId}.jsonl`),
    );
    await applyParseOutcome(database.db, {
      source,
      outcome: outcomeOf(
        makeConversation(source, {
          nativeId,
          turns: options.turns,
          ...options.overrides,
        }),
      ),
      links: {
        projectPath: options.projectPath ?? null,
        agentUiSessionId: options.agentUiSessionId ?? null,
      },
      parserVersion: 1,
      now: 1,
    });
    const conversation = await database.db
      .selectFrom("conversations")
      .select(["id", "title"])
      .where("agent", "=", agent)
      .where("native_id", "=", nativeId)
      .executeTakeFirstOrThrow();
    const turns = await database.db
      .selectFrom("turns")
      .selectAll()
      .where("conversation_id", "=", conversation.id)
      .execute();
    for (const turn of turns) {
      const text = renderTurnText(turn.user_text, turn.assistant_text);
      await replaceTurnChunks(database.db, {
        turn: {
          turnId: turn.id,
          contentHash: turn.content_hash,
          title: conversation.title,
        },
        modelId: MODEL,
        chunkerVersion: 1,
        now: 1,
        chunks: [{ index: 0, text, tokenCount: 10, embedHash: `${turn.id}` }],
      });
      const chunk = await database.db
        .selectFrom("chunks")
        .select(["id", "embed_hash"])
        .where("turn_id", "=", turn.id)
        .executeTakeFirstOrThrow();
      await storeChunkVector(
        database.db,
        { id: chunk.id, embedHash: chunk.embed_hash },
        fakeEmbedding(text),
        1,
      );
    }
    return conversation.id;
  }

  const anonContext = { cwd: null, canScheduleSessions: false };
  const ownContext = {
    sessionId: "own-session",
    cwd: "/work/app",
    canScheduleSessions: false,
  };

  beforeEach(async () => {
    ({ database, cleanup } = await createTempDatabase());
    sourceDir = await mkdtemp(path.join(tmpdir(), "agent-ui-past-sessions-"));
    enabled = true;
    searchCalls = [];
    state = {
      ...defaultSessionMemoryState,
      enabled: true,
      lastSyncFinishedAt: 1,
      embedding: {
        ...defaultSessionMemoryState.embedding,
        chunksEmbedded: 10,
        chunksTotal: 10,
      },
    };
    sessions = {
      "own-session": {
        type: "claude-local-terminal",
        sessionId: "own-session",
        title: "Current work",
        startupConfig: { cwd: "/work/site" },
      } as unknown as Session,
      "ocr-session": {
        type: "codex-local-terminal",
        sessionId: "ocr-session",
        title: "OCR benchmark",
        codexSessionId: "codex-ocr",
        startupConfig: { cwd: "/work/app" },
      } as unknown as Session,
    };
    services = {
      sessionMemory: {
        isEnabled: () => enabled,
        getState: () => state,
        getDatabase: async () => database.db,
        searchSessionMemory: async (input) => {
          searchCalls.push(input);
          const { query, limit, groupBy, ...filters } = input;
          return await searchChunks(database.db, {
            ...filters,
            vector: fakeEmbedding(query),
            modelId: MODEL,
            limit: limit ?? 10,
            groupBy,
          });
        },
      },
      projectsState: { state: projects },
      sessions: { state: { state: sessions } },
    };

    await addConversation("codex-ocr", {
      overrides: {
        agent: "codex",
        cwd: "/work/app",
        gitBranch: "feat/ocr",
        startedAtMs: tokyo(3, 14),
        updatedAtMs: tokyo(3, 18),
      },
      projectPath: "/work/app",
      agentUiSessionId: "ocr-session",
      turns: [
        makeTurn(0, {
          startedAtMs: tokyo(3, 14),
          userText: "benchmark vision models for ocr receipts",
          assistantText: "luna 6 scored worst on ocr receipts accuracy",
          filePaths: ["/work/app/bench/ocr.py"],
          commands: ["python bench/ocr.py --model luna-6"],
        }),
        makeTurn(1, {
          startedAtMs: tokyo(3, 15),
          userText: "summarize the ocr benchmark",
          assistantText: "luna 6 was slowest, gemma best for ocr",
        }),
      ],
    });
    await addConversation("own-session", {
      overrides: {
        cwd: "/work/app",
        startedAtMs: tokyo(12, 9),
        updatedAtMs: tokyo(12, 11),
      },
      projectPath: "/work/app",
      agentUiSessionId: "own-session",
      turns: [
        makeTurn(0, {
          startedAtMs: tokyo(12, 9),
          userText: "retest luna 6 on ocr receipts benchmark",
          assistantText: "looking up the ocr benchmark",
        }),
      ],
    });
    await addConversation("own-subagent", {
      overrides: {
        cwd: "/work/app",
        relation: "subagent",
        parentNativeId: "own-session",
        startedAtMs: tokyo(12, 10),
        updatedAtMs: tokyo(12, 10),
      },
      projectPath: "/work/app",
      turns: [
        makeTurn(0, {
          userText: "find the ocr benchmark for luna 6",
          assistantText: "searching ocr receipts",
        }),
      ],
    });
    await addConversation("site-redesign", {
      overrides: {
        cwd: "/work/site",
        title: "Redesign the landing page",
        startedAtMs: tokyo(11, 10),
        updatedAtMs: tokyo(11, 12),
      },
      projectPath: "/work/site",
      turns: [
        makeTurn(0, {
          userText: "redesign the landing page hero",
          assistantText: "updated the hero layout",
        }),
      ],
    });
  });

  afterEach(async () => {
    await cleanup();
    await rm(sourceDir, { recursive: true, force: true });
  });

  describe("search_past_sessions", () => {
    it("formats hits with metadata, snippet and relevance", async () => {
      const text = await searchPastSessions(
        { query: "ocr benchmark luna 6" },
        services,
        ownContext,
        NOW,
      );
      expect(text).toContain('matched "ocr benchmark luna 6"');
      expect(text).toContain("Asia/Tokyo, UTC+09:00");
      expect(text).toMatch(/1\. conversation \d+ · codex · relevance 0\.\d\d/);
      expect(text).toContain("“benchmark vision models for ocr receipts”");
      expect(text).toContain("cwd /work/app · branch feat/ocr");
      expect(text).toContain("2026-10-03 14:00–18:00 · 2 turns");
      expect(text).toContain('agent-ui session "OCR benchmark" (ocr-session)');
      expect(text).toMatch(/turn \d · 2026-10-03 1\d:00:\n {5}User: /);
      expect(text).not.toContain("Coverage:");
    });

    it("excludes the calling session's conversation and its subagents", async () => {
      const text = await searchPastSessions(
        { query: "retest luna 6 ocr receipts benchmark" },
        services,
        ownContext,
        NOW,
      );
      expect(text).toContain("Your own current conversation is excluded.");
      expect(text).toContain("codex");
      expect(text).not.toContain("looking up the ocr benchmark");
      expect(text).not.toContain("searching ocr receipts");
      expect(searchCalls[0]?.excludeConversationIds).toHaveLength(2);
    });

    it("passes project, agent and date filters through", async () => {
      const text = await searchPastSessions(
        {
          query: "landing page",
          project: "site",
          agent: "claude",
          after: "2026-10-11",
          before: "2026-10-11",
        },
        services,
        anonContext,
        NOW,
      );
      expect(searchCalls[0]).toMatchObject({
        projectPath: "/work/site",
        agent: "claude",
        activeFrom: tokyo(11),
        activeTo: tokyo(12) - 1,
        groupBy: "conversation",
      });
      expect(text).toContain(
        "Filters: agent claude · project /work/site · active 2026-10-11 00:00 → 2026-10-11 23:59.",
      );
      expect(text).toContain("Redesign the landing page");
    });

    it("lists several matching turns per conversation when grouped by turn", async () => {
      const text = await searchPastSessions(
        {
          query: "ocr benchmark luna 6",
          group_by: "turn",
          project: "/work/app",
        },
        services,
        ownContext,
        NOW,
      );
      expect(searchCalls[0]).toMatchObject({ groupBy: "chunk", limit: 20 });
      expect(text).toMatch(/2 past turns matched/);
      expect(text.match(/conversation \d+ · codex/g)).toHaveLength(1);
      expect(text).toMatch(/turn 0 · 2026-10-03 14:00 · relevance/);
      expect(text).toMatch(/turn 1 · 2026-10-03 15:00 · relevance/);
    });

    it("adds a coverage note while embedding is incomplete", async () => {
      state.embedding = {
        ...state.embedding,
        status: "paused",
        chunksEmbedded: 2300,
        chunksTotal: 4888,
      };
      const text = await searchPastSessions(
        { query: "landing page" },
        services,
        anonContext,
        NOW,
      );
      expect(text).toContain(
        "Coverage: Embedded 2,300 / 4,888 chunks, newest first; older sessions may be missing (list_past_sessions covers them). Embedding is paused by the user.",
      );
    });

    it("explains how to continue when nothing matches", async () => {
      const text = await searchPastSessions(
        { query: "ocr", after: "2027-01-01" },
        services,
        anonContext,
        NOW,
      );
      expect(text).toContain("0 past conversations matched");
      expect(text).toContain("No matches.");
    });

    it("rejects bad input with a readable message", async () => {
      await expect(
        searchPastSessions(
          { query: "ocr", after: "last tuesday" },
          services,
          anonContext,
          NOW,
        ),
      ).rejects.toThrow(/Could not parse after="last tuesday"/);
      await expect(
        searchPastSessions(
          { query: "ocr", after: "2026-10-05", before: "2026-10-01" },
          services,
          anonContext,
          NOW,
        ),
      ).rejects.toThrow(/is later than before/);
      await expect(
        searchPastSessions({ query: "  " }, services, anonContext, NOW),
      ).rejects.toThrow(PastSessionsInputError);
    });
  });

  describe("list_past_sessions", () => {
    it("lists main conversations by recency without the caller's own", async () => {
      const text = await listPastSessions({}, services, ownContext, NOW);
      const ids = [...text.matchAll(/^\[(\d+)\] (\w+)/gm)].map(
        (match) => match[2],
      );
      expect(ids).toEqual(["claude", "codex"]);
      expect(text).toContain("Redesign the landing page");
      expect(text).toContain("Filters: main and fork conversations only.");
      expect(text).not.toContain("retest luna 6");
    });

    it("filters by project, agent and time window", async () => {
      const text = await listPastSessions(
        { project: "app", after: "yesterday", relation: "all" },
        services,
        anonContext,
        NOW,
      );
      expect(text).toContain(
        "Filters: project /work/app · active 2026-10-11 00:00 → now.",
      );
      expect(text).toContain("2 past conversations");
      expect(text).toContain("claude · subagent of own-session ·");

      const codex = await listPastSessions(
        { agent: "codex", before: "2026-10-03T13:00" },
        services,
        anonContext,
        NOW,
      );
      expect(codex).toContain("0 past conversations");
    });

    it("filters by the calling session's project with project current", async () => {
      const text = await listPastSessions(
        { project: "current" },
        services,
        ownContext,
      );
      expect(text).toContain("current project /work/site");
      expect(text).not.toContain("codex · ");
    });

    describe("inbox filter", () => {
      function inboxSession(
        sessionId: string,
        fields: Record<string, unknown>,
      ): Session {
        return {
          type: "claude-local-terminal",
          sessionId,
          status: "idle",
          createdAt: NOW - 5 * HOUR,
          lastActivityAt: NOW - 2 * HOUR,
          startupConfig: { cwd: "/work/app" },
          ...fields,
        } as unknown as Session;
      }

      beforeEach(async () => {
        Object.assign(sessions["ocr-session"] as object, {
          status: "stopped",
          lastActivityAt: NOW - 3 * HOUR,
          settledAt: NOW - HOUR,
          settledOverride: "settled",
        });
        sessions["review-session"] = inboxSession("review-session", {
          title: "Review the PR",
          status: "awaiting_user_response",
        });
        sessions["snoozed-session"] = inboxSession("snoozed-session", {
          type: "cursor-agent",
          title: "Docs cleanup",
          snoozedUntil: NOW + HOUR,
          snoozedAt: NOW - HOUR,
          startupConfig: { cwd: "/work/site" },
        });
        sessions["fresh-session"] = inboxSession("fresh-session", {
          title: "Fresh start",
          status: "running",
        });
        sessions["setup-session"] = inboxSession("setup-session", {
          type: "worktree-setup",
          title: "Worktree setup",
        });

        await addConversation("review-native", {
          overrides: { cwd: "/work/app", title: "Review the PR" },
          projectPath: "/work/app",
          agentUiSessionId: "review-session",
          turns: [makeTurn(0, { userText: "review the open PR" })],
        });
        await addConversation("docs-native", {
          overrides: {
            agent: "cursor",
            cwd: "/work/site",
            title: "Docs cleanup",
          },
          projectPath: "/work/site",
          agentUiSessionId: "snoozed-session",
          turns: [makeTurn(0, { userText: "clean up the docs" })],
        });
      });

      it("lists conversations of unsettled sessions with their inbox state", async () => {
        const text = await listPastSessions(
          { inbox: "unsettled" },
          services,
          ownContext,
          NOW,
        );
        expect(text).toContain("unsettled Agent UI sessions");
        expect(text).toContain("2 past conversations");
        expect(text).toContain(
          'agent-ui session "Review the PR" (review-session) · inbox: active, waiting for input',
        );
        expect(text).toContain(
          'agent-ui session "Docs cleanup" (snoozed-session) · inbox: snoozed until 2026-10-12 13:00',
        );
        expect(text).not.toContain("OCR benchmark");
        expect(text).toContain(
          'Not indexed yet, so not listed: "Fresh start" (fresh-session).',
        );
        expect(text).not.toContain("Worktree setup");
        expect(text).not.toContain("own-session");
      });

      it("selects settled sessions and narrows by project", async () => {
        const settled = await listPastSessions(
          { inbox: "settled" },
          services,
          ownContext,
          NOW,
        );
        expect(settled).toContain("1 past conversation,");
        expect(settled).toContain(
          'agent-ui session "OCR benchmark" (ocr-session) · inbox: settled',
        );
        expect(settled).not.toContain("Not indexed yet");

        const site = await listPastSessions(
          { inbox: "unsettled", project: "site" },
          services,
          ownContext,
          NOW,
        );
        expect(site).toContain("1 past conversation,");
        expect(site).toContain("Docs cleanup");
        expect(site).not.toContain("Fresh start");
      });
    });

    it("pages 20 conversations at a time with offset", async () => {
      for (let index = 0; index < 20; index++) {
        await addConversation(`extra-${index}`, {
          turns: [makeTurn(0, { userText: `extra question ${index}` })],
        });
      }
      const first = await listPastSessions({}, services, ownContext);
      expect(first).toContain("20 past conversations");
      expect(first).toContain("More results: call again with offset=20.");
      const second = await listPastSessions(
        { offset: 20 },
        services,
        ownContext,
      );
      expect(second).toContain("(offset 20)");
      expect(second).not.toContain("More results");
    });
  });

  describe("read_past_session", () => {
    async function addLongConversation(): Promise<number> {
      const sourcePath = path.join(sourceDir, "long.jsonl");
      await writeFile(sourcePath, "{}\n");
      return await addConversation("long", {
        sourcePath,
        overrides: {
          agent: "codex",
          cwd: "/work/app/pkg",
          gitSha: "abc1234",
          title: "Long investigation",
        },
        projectPath: "/work/app",
        turns: Array.from({ length: 6 }, (_, ordinal) =>
          makeTurn(ordinal, {
            userText: `question ${ordinal}`,
            assistantText: `answer ${ordinal} ${"x".repeat(5_000)} conclusion ${ordinal}`,
            filePaths: [`/work/app/file-${ordinal}.ts`],
            commands: [`pnpm test --filter ${ordinal}`],
          }),
        ),
      });
    }

    it("prints the header and pages through turns", async () => {
      const id = await addLongConversation();
      const first = await readPastSession(
        { conversation_id: id },
        services,
        NOW,
      );
      expect(first).toContain(`Conversation ${id} · codex · main`);
      expect(first).toContain("Title: Long investigation");
      expect(first).toContain("Project: /work/app\nCwd: /work/app/pkg");
      expect(first).toContain("Git: branch main · sha abc1234");
      expect(first).toContain("6 turns (0–5)");
      expect(first).toContain("long.jsonl (exists)");
      expect(first).toContain("Files: /work/app/file-0.ts");
      expect(first).toContain("  $ pnpm test --filter 0");
      expect(first.length).toBeLessThanOrEqual(20_200);
      const next = /Continue with from_turn=(\d+)\./.exec(first)?.[1];
      expect(next).toBeDefined();

      const rest = await readPastSession(
        {
          conversation_id: String(id),
          from_turn: Number(next),
        },
        services,
        NOW,
      );
      expect(rest).toContain(`### turn ${next}`);
      expect(rest).toContain("### turn 5");
      expect(rest).toContain("End of conversation.");
    });

    it("reads a bounded range and says where the conversation continues", async () => {
      const id = await addLongConversation();
      const text = await readPastSession(
        { conversation_id: id, from_turn: 1, to_turn: 2 },
        services,
        NOW,
      );
      expect(text).not.toContain("### turn 0");
      expect(text).toContain("### turn 2");
      expect(text).not.toContain("### turn 3");
      expect(text).toContain(
        "End of the requested range; the conversation continues up to turn 5 (from_turn=3).",
      );
    });

    it("shortens oversized turns, keeping the ending", async () => {
      const sourcePath = path.join(sourceDir, "missing.jsonl");
      const id = await addConversation("huge", {
        sourcePath,
        turns: [
          makeTurn(0, {
            userText: "start",
            assistantText: `intro ${"y".repeat(50_000)} final conclusion`,
          }),
        ],
      });
      const text = await readPastSession(
        { conversation_id: id },
        services,
        NOW,
      );
      expect(text.length).toBeLessThanOrEqual(20_400);
      expect(text).toContain("final conclusion");
      expect(text).toContain("chars omitted");
      expect(text).toContain("Shortened turns (marked […]): 0.");
      expect(text).toContain("missing.jsonl (no longer on disk)");
      expect(text).toContain("End of conversation.");
    });

    it("finds conversations by native id and reports unknown ids", async () => {
      const text = await readPastSession(
        { conversation_id: "codex-ocr" },
        services,
        NOW,
      );
      expect(text).toContain("· codex · main");
      expect(text).toContain("Native id: codex-ocr");
      await expect(
        readPastSession({ conversation_id: 999 }, services, NOW),
      ).rejects.toThrow(/No indexed conversation matches "999"/);
    });
  });

  describe("runPastSessionsTool", () => {
    it("returns a clear message when session memory is disabled", async () => {
      enabled = false;
      const run = vi.fn(async () => "unused");
      const result = await runPastSessionsTool(
        "search_past_sessions",
        services,
        run,
      );
      expect(run).not.toHaveBeenCalled();
      expect(result).toEqual({
        content: [{ type: "text", text: SESSION_MEMORY_DISABLED_MESSAGE }],
        isError: true,
      });
    });

    it("turns failures into text results", async () => {
      const unavailable = await runPastSessionsTool(
        "search_past_sessions",
        services,
        async () => {
          throw new SessionMemoryUnavailableError(
            "Session memory search is not supported here",
          );
        },
      );
      expect(unavailable).toMatchObject({
        isError: true,
        content: [
          {
            text: "Session memory search is not supported here. Use list_past_sessions and read_past_session instead.",
          },
        ],
      });

      const crashed = await runPastSessionsTool(
        "read_past_session",
        services,
        async () => {
          throw new Error("database is locked");
        },
      );
      expect(crashed).toMatchObject({
        isError: true,
        content: [
          {
            text: "read_past_session failed: database is locked. Retry once; if it keeps failing, tell the user.",
          },
        ],
      });
      expect(loggerMocks.error).toHaveBeenCalled();
    });
  });
});

describe("searchCoverageNote", () => {
  it("is silent when the index is complete", () => {
    expect(
      searchCoverageNote({
        ...defaultSessionMemoryState,
        lastSyncFinishedAt: 1,
      }),
    ).toBeNull();
  });

  it("reports a missing first sync and embedding errors", () => {
    expect(
      searchCoverageNote({
        ...defaultSessionMemoryState,
        syncStatus: "syncing",
        embedding: {
          ...defaultSessionMemoryState.embedding,
          status: "error",
          lastError: "worker crashed",
        },
      }),
    ).toBe(
      "Coverage: The first index sync is still running; results are incomplete. Embedding stopped with an error (worker crashed).",
    );
  });
});
