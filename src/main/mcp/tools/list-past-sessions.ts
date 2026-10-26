import type { ClaudeProject } from "@shared/claude-types";
import { partitionInboxSessions } from "@shared/session-lifecycle";
import {
  type SessionMemoryAgent,
  type SessionMemoryRelation,
  sessionMemoryAgents,
  sessionMemoryRelations,
} from "@shared/session-memory";
import { z } from "zod";
import { excerpt, loadDisplayTitles } from "../../session-memory/display";
import {
  findIndexedAgentUiSessionIds,
  listConversations,
} from "../../session-memory/store/queries";
import type { Session } from "../../sessions/state";
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
  type ProjectFilter,
  plural,
  resolveActiveWindow,
  resolveOwnConversationIds,
  resolveProjectFilter,
  runPastSessionsTool,
  sessionMatchesProjectFilter,
  sessionMemoryAgentOf,
  timezoneLabel,
} from "./past-sessions";

const PAGE_SIZE = 20;
const MAX_UNINDEXED_SESSIONS_SHOWN = 10;

const inboxFilters = ["unsettled", "active", "snoozed", "settled"] as const;
type InboxFilter = (typeof inboxFilters)[number];

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
  inbox: z
    .enum(inboxFilters)
    .optional()
    .describe(
      "Only Agent UI sessions in this inbox state; unsettled = active or snoozed.",
    ),
  offset: z
    .number()
    .int()
    .optional()
    .describe(`Conversations to skip; pages hold ${PAGE_SIZE}.`),
};

type ListInput = z.output<z.ZodObject<typeof listPastSessionsInputSchema>>;

/** Same partition as the inbox sidebar, limited to sessions with agent transcripts. */
function resolveInboxSessions(
  inbox: InboxFilter,
  filters: { agent?: SessionMemoryAgent; project?: ProjectFilter },
  sessions: Readonly<Record<string, Session>>,
  projects: readonly ClaudeProject[],
  context: McpRequestContext,
  now: number,
): Session[] {
  const candidates = Object.values(sessions).filter((session) => {
    const agent = sessionMemoryAgentOf(session);
    return (
      agent !== null &&
      session.sessionId !== context.sessionId &&
      (filters.agent === undefined || agent === filters.agent) &&
      (filters.project === undefined ||
        sessionMatchesProjectFilter(session, filters.project, projects))
    );
  });
  const { active, snoozed, settled } = partitionInboxSessions(candidates, now);
  switch (inbox) {
    case "unsettled":
      return [...active, ...snoozed];
    case "active":
      return active;
    case "snoozed":
      return snoozed;
    case "settled":
      return settled;
    default: {
      const exhaustive: never = inbox;
      return exhaustive;
    }
  }
}

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

  const inboxSessions = input.inbox
    ? resolveInboxSessions(
        input.inbox,
        { agent: input.agent, project },
        sessions,
        services.projectsState.state,
        context,
        now,
      )
    : undefined;

  const db = await services.sessionMemory.getDatabase();
  const excluded = await resolveOwnConversationIds(db, sessions, context);
  const rows = await listConversations(db, {
    agentUiSessionId: inboxSessions?.map((session) => session.sessionId),
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
    inbox: input.inbox && `${input.inbox} Agent UI sessions`,
  });
  if (filters) lines.push(filters);
  if (excluded.length > 0) {
    lines.push("Your own current conversation is excluded.");
  }
  const coverage = coverageNote(services.sessionMemory.getState());
  if (coverage) lines.push(`Coverage: ${coverage}`);
  if (inboxSessions && offset === 0) {
    const indexed = await findIndexedAgentUiSessionIds(
      db,
      inboxSessions.map((session) => session.sessionId),
    );
    const unindexed = inboxSessions.filter(
      (session) => !indexed.has(session.sessionId),
    );
    if (unindexed.length > 0) {
      const shown = unindexed
        .slice(0, MAX_UNINDEXED_SESSIONS_SHOWN)
        .map(
          (session) => `"${excerpt(session.title, 60)}" (${session.sessionId})`,
        );
      const more = unindexed.length - shown.length;
      lines.push(
        `Not indexed yet, so not listed: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}.`,
      );
    }
  }

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
      now,
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
    'Lists the user\'s agent conversations by recency, without a query. Use it for time-based references where search_past_sessions is weak, or with inbox for Agent UI inbox sessions ("my unsettled sessions"). Same policy as search_past_sessions: only when the user or orchestrator explicitly refers to other sessions or past work.',
  inputSchema: listPastSessionsInputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
  isAvailable: isPastSessionsAvailable,
  handler: (input, services, context) =>
    runPastSessionsTool("list_past_sessions", services, () =>
      listPastSessions(input, services, context),
    ),
});
