import { sessionMemoryAgents } from "@shared/session-memory";
import { z } from "zod";
import { excerpt, formatDisplayTitle } from "../../session-memory/display";
import { searchConversations } from "../../session-memory/search-conversations";
import { defineMcpTool } from "../define-tool";
import type { McpRequestContext } from "../session-token";
import {
  currentSessionCwd,
  describeFilters,
  formatActiveRange,
  formatAgentUiSession,
  formatLocalTime,
  formatLocation,
  formatRelation,
  isPastSessionsAvailable,
  PastSessionsInputError,
  type PastSessionsServices,
  plural,
  resolveActiveWindow,
  resolveOwnConversationIds,
  resolveProjectFilter,
  runPastSessionsTool,
  searchCoverageNote,
  timezoneLabel,
} from "./past-sessions";

const RESULT_LIMIT = 10;
const SNIPPET_CHARS = 400;

export const searchPastSessionsInputSchema = {
  query: z
    .string()
    .describe(
      "What to look for, phrased like the content you expect, e.g. 'benchmark vision models for OCR, luna 6 results'.",
    ),
  agent: z.enum(sessionMemoryAgents).optional(),
  project: z
    .string()
    .optional()
    .describe(
      'Agent UI project name, "current" for the project this session runs in (its worktrees included), or an absolute path; other paths match conversations whose cwd is inside them.',
    ),
  after: z
    .string()
    .optional()
    .describe(
      "Only conversations active at or after this: YYYY-MM-DD, ISO datetime, today, yesterday, or an age like 7d.",
    ),
  before: z
    .string()
    .optional()
    .describe(
      "Only conversations active at or before this; a date-only value includes that whole day.",
    ),
  group_by: z
    .enum(["conversation", "turn"])
    .optional()
    .describe(
      "conversation (default): best turn per conversation. turn: several matching turns per conversation.",
    ),
};

type SearchInput = z.output<z.ZodObject<typeof searchPastSessionsInputSchema>>;

export async function searchPastSessions(
  input: SearchInput,
  services: PastSessionsServices,
  context: McpRequestContext,
  now = Date.now(),
): Promise<string> {
  const query = input.query.trim();
  if (!query) {
    throw new PastSessionsInputError("query must not be empty.");
  }
  const sessions = services.sessions.state.state;
  const project = input.project?.trim()
    ? resolveProjectFilter(
        input.project,
        services.projectsState.state,
        currentSessionCwd(sessions, context),
      )
    : undefined;
  const window = resolveActiveWindow(input, now);
  const byTurn = input.group_by === "turn";

  const db = await services.sessionMemory.getDatabase();
  const excluded = await resolveOwnConversationIds(db, sessions, context);
  const matches = await searchConversations(services.sessionMemory, {
    query,
    agent: input.agent,
    projectPath: project?.projectPath,
    cwdPrefix: project?.cwdPrefix,
    ...window,
    excludeConversationIds: excluded,
    limit: RESULT_LIMIT,
    groupBy: byTurn ? "turn" : "conversation",
    snippetChars: SNIPPET_CHARS,
  });
  const hitCount = matches.reduce((sum, match) => sum + match.turns.length, 0);

  const lines: string[] = [];
  const unit = byTurn ? "turn" : "conversation";
  lines.push(
    `${hitCount} past ${unit}${hitCount === 1 ? "" : "s"} matched "${excerpt(query, 120)}". Relevance is cosine similarity (higher is closer). Times are local (${timezoneLabel(now)}).`,
  );
  const filters = describeFilters({ agent: input.agent, project, ...window });
  if (filters) lines.push(filters);
  if (excluded.length > 0) {
    lines.push("Your own current conversation is excluded.");
  }
  const coverage = searchCoverageNote(services.sessionMemory.getState());
  if (coverage) lines.push(coverage);

  if (matches.length === 0) {
    lines.push(
      "",
      "No matches. Try different wording, fewer filters, or list_past_sessions for time-based lookups.",
    );
    return lines.join("\n");
  }

  matches.forEach(({ conversation, turns }, index) => {
    const best = turns[0];
    if (!best) return;
    const relation = formatRelation(conversation);
    lines.push(
      "",
      `${index + 1}. conversation ${conversation.id} · ${conversation.agent}${relation ? ` · ${relation}` : ""} · relevance ${best.relevance.toFixed(2)}`,
      `   ${formatDisplayTitle(conversation.title, conversation.firstUserText)}`,
    );
    const location = formatLocation(conversation);
    if (location) lines.push(`   ${location}`);
    const details = [
      formatActiveRange(conversation.startedAt, conversation.updatedAt),
      plural(conversation.turnCount, "turn"),
    ];
    const agentUiSession = formatAgentUiSession(
      conversation.agentUiSessionId,
      sessions,
    );
    if (agentUiSession) details.push(agentUiSession);
    lines.push(`   ${details.join(" · ")}`);
    for (const turn of turns) {
      const time =
        turn.startedAt !== null ? ` · ${formatLocalTime(turn.startedAt)}` : "";
      const relevance =
        turns.length > 1 ? ` · relevance ${turn.relevance.toFixed(2)}` : "";
      lines.push(
        `   turn ${turn.ordinal}${time}${relevance}:`,
        `     ${turn.snippet}`,
      );
    }
  });
  lines.push(
    "",
    "Next: read_past_session with the conversation id, starting a turn or two before the matching turn.",
  );
  return lines.join("\n");
}

export const searchPastSessionsTool = defineMcpTool({
  name: "search_past_sessions",
  description: [
    "Semantic search over the user's past Claude Code, Codex and Cursor conversations on this machine.",
    'Use ONLY when the user or orchestrator explicitly refers to earlier sessions or past work, e.g. "continue the auth refactor from yesterday", "how did we fix this last time?". Never call it proactively or just in case.',
    "If you can spawn a subagent, delegate the whole lookup: give it the user's reference, the goal, and what you want to retrieve",
    "Workflow: search, or list_past_sessions for purely time-based references; then read_past_session on the most promising conversations.",
    "Past conclusions are historical claims: check that referenced files, branches and commits still exist before relying on them",
  ].join("\n"),
  inputSchema: searchPastSessionsInputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
  isAvailable: isPastSessionsAvailable,
  handler: (input, services, context) =>
    runPastSessionsTool("search_past_sessions", services, () =>
      searchPastSessions(input, services, context),
    ),
});
