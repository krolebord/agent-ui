import {
  type SessionMemoryRelation,
  sessionMemoryAgents,
  sessionMemoryRelations,
} from "@shared/session-memory";
import { z } from "zod";
import { loadDisplayTitles } from "../../session-memory/display";
import { listConversations } from "../../session-memory/store/queries";
import { defineMcpTool } from "../define-tool";
import type { McpRequestContext } from "../session-token";
import {
  clampInteger,
  coverageNote,
  currentSessionCwd,
  describeFilters,
  formatActiveRange,
  formatAgentUiSession,
  formatLocation,
  formatRelation,
  isPastSessionsAvailable,
  type PastSessionsServices,
  plural,
  resolveActiveWindow,
  resolveOwnConversationIds,
  resolveProjectFilter,
  runPastSessionsTool,
  timezoneLabel,
} from "./past-sessions";

const PAGE_SIZE = 20;

export const listPastSessionsInputSchema = {
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
  relation: z
    .enum([...sessionMemoryRelations, "all"])
    .optional()
    .describe(
      "Default: main and forked conversations; forks only hold their own turns, not the copied history.",
    ),
  offset: z
    .number()
    .int()
    .optional()
    .describe(`Conversations to skip; pages hold ${PAGE_SIZE}.`),
};

type ListInput = z.output<z.ZodObject<typeof listPastSessionsInputSchema>>;

export async function listPastSessions(
  input: ListInput,
  services: PastSessionsServices,
  context: McpRequestContext,
  now = Date.now(),
): Promise<string> {
  const sessions = services.sessions.state.state;
  const project = input.project?.trim()
    ? resolveProjectFilter(
        input.project,
        services.projectsState.state,
        currentSessionCwd(sessions, context),
      )
    : undefined;
  const window = resolveActiveWindow(input, now);
  const limit = PAGE_SIZE;
  const offset = clampInteger(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const relations: SessionMemoryRelation[] | undefined =
    input.relation === "all"
      ? undefined
      : input.relation
        ? [input.relation]
        : ["main", "fork"];

  const db = await services.sessionMemory.getDatabase();
  const excluded = await resolveOwnConversationIds(db, sessions, context);
  const rows = await listConversations(db, {
    agent: input.agent,
    projectPath: project?.projectPath,
    cwdPrefix: project?.cwdPrefix,
    ...window,
    relation: relations,
    excludeIds: excluded,
    limit: limit + 1,
    offset,
  });
  const hasMore = rows.length > limit;
  const conversations = rows.slice(0, limit);
  const titles = await loadDisplayTitles(db, conversations);

  const lines: string[] = [];
  lines.push(
    `${conversations.length} past conversation${conversations.length === 1 ? "" : "s"}, most recently active first${offset > 0 ? ` (offset ${offset})` : ""}. Times are local (${timezoneLabel(now)}).`,
  );
  const filters = describeFilters({
    agent: input.agent,
    project,
    ...window,
    relation: relations && `${relations.join(" and ")} conversations only`,
  });
  if (filters) lines.push(filters);
  if (excluded.length > 0) {
    lines.push("Your own current conversation is excluded.");
  }
  const coverage = coverageNote(services.sessionMemory.getState());
  if (coverage) lines.push(`Coverage: ${coverage}`);

  if (conversations.length === 0) {
    lines.push(
      "",
      "No conversations matched. Widen the dates or drop filters.",
    );
    return lines.join("\n");
  }

  for (const conversation of conversations) {
    const relationLabel = formatRelation(conversation);
    lines.push(
      "",
      `[${conversation.id}] ${conversation.agent}${relationLabel ? ` · ${relationLabel}` : ""} · ${formatActiveRange(conversation.startedAt, conversation.updatedAt)} · ${plural(conversation.turnCount, "turn")}`,
      `   ${titles.get(conversation.id) ?? "(untitled)"}`,
    );
    const location = formatLocation(conversation);
    if (location) lines.push(`   ${location}`);
    const agentUiSession = formatAgentUiSession(
      conversation.agentUiSessionId,
      sessions,
    );
    if (agentUiSession) lines.push(`   ${agentUiSession}`);
  }
  lines.push(
    "",
    hasMore
      ? `More results: call again with offset=${offset + limit}. Read one with read_past_session conversation_id=<id in brackets>.`
      : "Read one with read_past_session conversation_id=<id in brackets>.",
  );
  return lines.join("\n");
}

export const listPastSessionsTool = defineMcpTool({
  name: "list_past_sessions",
  description:
    "Lists the user's past agent conversations by recency, without a query. Use it for time-based references where search_past_sessions is weak. Same policy as search_past_sessions: only when the user or orchestrator explicitly refers to past work.",
  inputSchema: listPastSessionsInputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
  isAvailable: isPastSessionsAvailable,
  handler: (input, services, context) =>
    runPastSessionsTool("list_past_sessions", services, () =>
      listPastSessions(input, services, context),
    ),
});
