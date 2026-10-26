import { sessionMemoryAgents } from "@shared/session-memory";
import { z } from "zod";
import { loadDisplayTitles } from "../../session-memory/display";
import type { SessionMemoryDb } from "../../session-memory/store/database";
import {
  type ConversationRecord,
  getConversation,
  getTurns,
  type TurnRecord,
} from "../../session-memory/store/queries";
import { defineMcpTool } from "../define-tool";
import {
  clampInteger,
  formatActiveRange,
  formatAgentUiSession,
  formatCount,
  formatLocalTime,
  formatRelation,
  isPastSessionsAvailable,
  PastSessionsInputError,
  type PastSessionsServices,
  pathExists,
  plural,
  runPastSessionsTool,
  timezoneLabel,
} from "./past-sessions";

const MAX_CHARS = 20_000;
const MAX_TURN_CHARS_IN_RANGE = 12_000;
const TURN_BATCH = 100;
const MAX_FILE_PATHS = 25;
const MAX_COMMANDS = 15;
const MAX_COMMAND_CHARS = 200;

export const readPastSessionInputSchema = {
  conversation_id: z
    .union([z.number().int(), z.string()])
    .describe(
      "Conversation id from search_past_sessions or list_past_sessions, or a native Claude/Codex/Cursor session id.",
    ),
  from_turn: z
    .number()
    .int()
    .optional()
    .describe("First turn ordinal to include (default 0)."),
  to_turn: z
    .number()
    .int()
    .optional()
    .describe("Last turn ordinal to include (inclusive)."),
};

type ReadInput = z.output<z.ZodObject<typeof readPastSessionInputSchema>>;

async function findConversation(
  db: SessionMemoryDb,
  rawId: number | string,
): Promise<ConversationRecord | null> {
  const value = typeof rawId === "number" ? String(rawId) : rawId.trim();
  if (/^\d+$/.test(value)) {
    const byId = await getConversation(db, { id: Number(value) });
    if (byId) return byId;
  }
  for (const agent of sessionMemoryAgents) {
    const byNativeId = await getConversation(db, { agent, nativeId: value });
    if (byNativeId) return byNativeId;
  }
  return null;
}

/** Keeps the start and the end, where conclusions usually are. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = (omitted: number) =>
    `\n[… ${formatCount(omitted)} chars omitted …]\n`;
  const budget = Math.max(0, maxChars - marker(text.length).length);
  const head = Math.ceil(budget * 0.6);
  const tail = budget - head;
  return `${text.slice(0, head).trimEnd()}${marker(text.length - head - tail)}${text.slice(text.length - tail).trimStart()}`;
}

function renderList(turn: TurnRecord): string[] {
  const lines: string[] = [];
  if (turn.filePaths.length > 0) {
    const shown = turn.filePaths.slice(0, MAX_FILE_PATHS);
    const more = turn.filePaths.length - shown.length;
    lines.push(
      `Files: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`,
    );
  }
  if (turn.commands.length > 0) {
    const shown = turn.commands.slice(0, MAX_COMMANDS);
    const more = turn.commands.length - shown.length;
    lines.push("Commands:");
    for (const command of shown) {
      const singleLine = command.replace(/\s*\n\s*/g, " ⏎ ");
      lines.push(
        `  $ ${singleLine.length > MAX_COMMAND_CHARS ? `${singleLine.slice(0, MAX_COMMAND_CHARS)}…` : singleLine}`,
      );
    }
    if (more > 0) lines.push(`  (+${more} more)`);
  }
  return lines;
}

export function renderTurn(
  turn: TurnRecord,
  maxChars: number,
): { text: string; truncated: boolean } {
  const header = `### turn ${turn.ordinal}${turn.startedAt !== null ? ` · ${formatLocalTime(turn.startedAt)}` : ""}${turn.sourceLine !== null ? ` · source line ${turn.sourceLine}` : ""}`;
  const extras = renderList(turn).join("\n");
  const userText = turn.userText.trim();
  const assistantText = turn.assistantText.trim();
  const fixed =
    header.length +
    extras.length +
    "User:\n".length +
    "Assistant:\n".length +
    8;
  const textBudget = Math.max(400, maxChars - fixed);
  let user = userText;
  let assistant = assistantText;
  let truncated = false;
  if (userText.length + assistantText.length > textBudget) {
    truncated = true;
    const userShare = Math.min(
      userText.length,
      Math.max(Math.floor(textBudget * 0.3), textBudget - assistantText.length),
    );
    user = truncateMiddle(userText, userShare);
    assistant = truncateMiddle(assistantText, textBudget - user.length);
  }
  const parts = [header];
  if (user) parts.push(`User:\n${user}`);
  if (assistant) parts.push(`Assistant:\n${assistant}`);
  if (extras) parts.push(extras);
  return { text: parts.join("\n\n"), truncated };
}

export async function readPastSession(
  input: ReadInput,
  services: PastSessionsServices,
  now = Date.now(),
): Promise<string> {
  const db = await services.sessionMemory.getDatabase();
  const conversation = await findConversation(db, input.conversation_id);
  if (!conversation) {
    throw new PastSessionsInputError(
      `No indexed conversation matches "${input.conversation_id}". Use ids from search_past_sessions or list_past_sessions.`,
    );
  }
  const lastOrdinal = conversation.turnCount - 1;
  const fromTurn = clampInteger(
    input.from_turn,
    0,
    0,
    Math.max(0, lastOrdinal),
  );
  const toTurn = clampInteger(
    input.to_turn,
    lastOrdinal,
    fromTurn,
    lastOrdinal,
  );
  const maxChars = MAX_CHARS;

  const title =
    (await loadDisplayTitles(db, [conversation])).get(conversation.id) ??
    "(untitled)";
  const sourceExists = await pathExists(conversation.sourcePath);
  const relation = formatRelation(conversation);
  const header: string[] = [
    `Conversation ${conversation.id} · ${conversation.agent} · ${relation ?? "main"}`,
    `Title: ${title}`,
  ];
  if (conversation.projectPath)
    header.push(`Project: ${conversation.projectPath}`);
  if (conversation.cwd) header.push(`Cwd: ${conversation.cwd}`);
  const git = [
    conversation.gitBranch ? `branch ${conversation.gitBranch}` : null,
    conversation.gitSha ? `sha ${conversation.gitSha}` : null,
  ].filter(Boolean);
  if (git.length > 0) header.push(`Git: ${git.join(" · ")}`);
  header.push(
    `Active: ${formatActiveRange(conversation.startedAt, conversation.updatedAt)} (${timezoneLabel(now)}) · ${plural(conversation.turnCount, "turn")} (0–${Math.max(0, lastOrdinal)})`,
    `Native id: ${conversation.nativeId}`,
  );
  const agentUiSession = formatAgentUiSession(
    conversation.agentUiSessionId,
    services.sessions.state.state,
    now,
  );
  if (agentUiSession) header.push(`Agent UI: ${agentUiSession}`);
  header.push(
    `Source: ${conversation.sourcePath} (${sourceExists ? "exists" : "no longer on disk"})`,
    sourceExists
      ? "Only user and assistant text, file paths and commands are stored here; tool outputs are not. For more detail, read the source JSONL near the turn's source line."
      : "Only user and assistant text, file paths and commands are stored here; tool outputs are not, and the source transcript is gone.",
  );

  if (conversation.turnCount === 0) {
    return [...header, "", "This conversation has no stored turns."].join("\n");
  }

  const output: string[] = [header.join("\n")];
  let used = output[0]?.length ?? 0;
  const perTurnCap = fromTurn === toTurn ? maxChars : MAX_TURN_CHARS_IN_RANGE;
  let lastShown: number | null = null;
  let stoppedAt: number | null = null;
  const truncatedTurns: number[] = [];

  let next = fromTurn;
  outer: while (next <= toTurn) {
    const turns = await getTurns(db, conversation.id, {
      fromOrdinal: next,
      toOrdinal: toTurn,
      limit: TURN_BATCH,
    });
    if (turns.length === 0) break;
    for (const turn of turns) {
      const remaining = maxChars - used - 2;
      let rendered = renderTurn(turn, perTurnCap);
      if (rendered.text.length > remaining) {
        if (lastShown !== null) {
          stoppedAt = turn.ordinal;
          break outer;
        }
        rendered = renderTurn(turn, remaining);
      }
      output.push(rendered.text);
      used += rendered.text.length + 2;
      if (rendered.truncated) truncatedTurns.push(turn.ordinal);
      lastShown = turn.ordinal;
    }
    next = (turns.at(-1)?.ordinal ?? toTurn) + 1;
  }

  const footer: string[] = [];
  if (truncatedTurns.length > 0) {
    footer.push(
      `Shortened turns (marked […]): ${truncatedTurns.join(", ")}. To see more of one, call again with from_turn and to_turn set to it${sourceExists ? ", or read the source transcript" : ""}.`,
    );
  }
  if (stoppedAt !== null) {
    footer.push(
      `Showing turns ${fromTurn}–${lastShown ?? fromTurn} of ${conversation.turnCount}; stopped at the size budget. Continue with from_turn=${stoppedAt}${toTurn < lastOrdinal ? ` to_turn=${toTurn}` : ""}.`,
    );
  } else if (toTurn < lastOrdinal) {
    footer.push(
      `End of the requested range; the conversation continues up to turn ${lastOrdinal} (from_turn=${toTurn + 1}).`,
    );
  } else {
    footer.push("End of conversation.");
  }
  output.push(`---\n${footer.join("\n")}`);
  return output.join("\n\n");
}

export const readPastSessionTool = defineMcpTool({
  name: "read_past_session",
  description:
    "Reads a past conversation found with search_past_sessions or list_past_sessions: a header (project, cwd, git branch, transcript path and whether it still exists), then each turn's user and assistant text, touched files and commands. Long output is paged; it ends with the from_turn to continue from. Only for explicit references to other sessions or past work.",
  inputSchema: readPastSessionInputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
  isAvailable: isPastSessionsAvailable,
  handler: (input, services) =>
    runPastSessionsTool("read_past_session", services, () =>
      readPastSession(input, services),
    ),
});
