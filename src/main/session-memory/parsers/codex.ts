import path from "node:path";
import {
  CODEX_FORK_COPY_MAX_GAP_MS,
  codexParentThreadId,
  codexSessionId,
  isCodexSubagentSessionMeta,
  isForkedSessionMeta,
} from "../../agent-transcripts/codex-session-meta";
import {
  asRecord,
  asString,
  parseTimestampMs,
} from "../../agent-transcripts/json";
import { countUnknownLine, emptyDiagnostics, readJsonlRecords } from "./read";
import { removeTaggedBlocks, tidyText } from "./text";
import { classifyOrigin } from "./text-generation";
import {
  codexExecCommands,
  commandFromArgv,
  patchFilePaths,
  toolInputRecord,
} from "./tool-inputs";
import { TurnCollector, type TurnPosition } from "./turns";
import type {
  ConversationRelation,
  ParseContext,
  ParseOutcome,
  TranscriptSource,
} from "./types";

const IGNORED_LINE_TYPES = new Set([
  "turn_context",
  "compacted",
  "world_state",
  "token_usage_record",
  "inter_agent_communication_metadata",
]);

const KNOWN_RESPONSE_ITEMS = new Set([
  "message",
  "reasoning",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "local_shell_call",
  "web_search_call",
  "agent_message",
]);

const INJECTED_USER_TAGS = [
  "environment_context",
  "user_instructions",
  "INSTRUCTIONS",
  "skill",
  "user_action",
  "turn_aborted",
];

const INJECTED_ITEM_PREFIX = new RegExp(
  `^(?:# AGENTS\\.md instructions|<(?:${INJECTED_USER_TAGS.join("|")})>)`,
);

const IMAGE_TAG = /<\/?image\b[^>]*>/g;

const ROLLOUT_ID =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function cleanCodexUserContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of content) {
    const record = asRecord(item);
    const text = record?.type === "input_text" ? asString(record.text) : null;
    if (text === null || INJECTED_ITEM_PREFIX.test(text.trimStart())) {
      continue;
    }
    parts.push(
      removeTaggedBlocks(text, INJECTED_USER_TAGS).replace(IMAGE_TAG, ""),
    );
  }
  return tidyText(parts.join("\n\n"));
}

function assistantContentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of content) {
    const record = asRecord(item);
    if (record?.type === "output_text" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  return parts.join("\n\n");
}

function recordToolCall(
  payload: Record<string, unknown>,
  turns: TurnCollector,
  position: TurnPosition,
): void {
  const name = asString(payload.name);
  if (payload.type === "local_shell_call") {
    turns.addCommand(
      commandFromArgv(asRecord(payload.action)?.command),
      position,
    );
    return;
  }
  if (payload.type === "custom_tool_call") {
    const input = asString(payload.input) ?? "";
    if (name === "exec") {
      for (const command of codexExecCommands(input)) {
        turns.addCommand(command, position);
      }
    }
    for (const filePath of patchFilePaths(input)) {
      turns.addFilePath(filePath, position);
    }
    return;
  }
  const args = toolInputRecord(payload.arguments);
  if (args === null) {
    return;
  }
  if (name === "exec_command") {
    turns.addCommand(asString(args.cmd), position);
  } else if (name === "shell" || name === "container.exec") {
    turns.addCommand(commandFromArgv(args.command), position);
  } else if (name === "apply_patch") {
    for (const filePath of patchFilePaths(asString(args.input) ?? "")) {
      turns.addFilePath(filePath, position);
    }
  }
}

interface CodexSessionMeta {
  id: string | null;
  cwd: string | null;
  gitBranch: string | null;
  gitSha: string | null;
  parentNativeId: string | null;
  relation: ConversationRelation;
}

function readSessionMeta(payload: Record<string, unknown>): CodexSessionMeta {
  const git = asRecord(payload.git);
  const parentNativeId = codexParentThreadId(payload);
  let relation: ConversationRelation = "main";
  if (isCodexSubagentSessionMeta(payload)) {
    relation = "subagent";
  } else if (typeof payload.forked_from_id === "string") {
    relation = "fork";
  }
  return {
    id: codexSessionId(payload),
    cwd: asString(payload.cwd) || null,
    gitBranch: asString(git?.branch) || null,
    gitSha: asString(git?.commit_hash) || null,
    parentNativeId,
    relation,
  };
}

export async function parseCodexTranscript(
  source: TranscriptSource,
  context: ParseContext,
): Promise<ParseOutcome> {
  const diagnostics = emptyDiagnostics();
  const turns = new TurnCollector();
  const state: {
    meta: CodexSessionMeta | null;
    turnContextCwd: string | null;
    turnId: string | null;
    suppressingForkCopies: boolean;
    forkCopyAnchorMs: number;
    startedAtMs: number | null;
    updatedAtMs: number | null;
  } = {
    meta: null,
    turnContextCwd: null,
    turnId: null,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
    startedAtMs: null,
    updatedAtMs: null,
  };

  const readable = await readJsonlRecords(
    source.path,
    diagnostics,
    (record, line) => {
      const type = asString(record.type) ?? "(none)";
      const payload = asRecord(record.payload);
      const timestampMs = parseTimestampMs(record.timestamp);

      if (type === "session_meta") {
        if (state.meta !== null || payload === null) {
          return;
        }
        state.meta = readSessionMeta(payload);
        state.startedAtMs = timestampMs;
        state.updatedAtMs = timestampMs;
        if (timestampMs !== null && isForkedSessionMeta(payload)) {
          state.suppressingForkCopies = true;
          state.forkCopyAnchorMs = timestampMs;
        }
        return;
      }

      if (state.suppressingForkCopies) {
        if (
          timestampMs === null ||
          timestampMs - state.forkCopyAnchorMs < CODEX_FORK_COPY_MAX_GAP_MS
        ) {
          state.forkCopyAnchorMs = timestampMs ?? state.forkCopyAnchorMs;
          return;
        }
        state.suppressingForkCopies = false;
      }

      if (timestampMs !== null) {
        state.startedAtMs ??= timestampMs;
        state.updatedAtMs = timestampMs;
      }
      if (payload === null) {
        if (!IGNORED_LINE_TYPES.has(type)) {
          countUnknownLine(diagnostics, type);
        }
        return;
      }

      const position: TurnPosition = {
        startedAtMs: timestampMs,
        line,
        eventId: state.turnId,
      };

      if (type === "turn_context") {
        state.turnContextCwd ??= asString(payload.cwd) || null;
        state.turnId = asString(payload.turn_id) ?? state.turnId;
        return;
      }
      if (type === "event_msg") {
        if (payload.type === "thread_rolled_back") {
          const count = payload.num_turns;
          turns.dropLastTurns(typeof count === "number" ? count : 0);
        } else if (payload.type === "patch_apply_end") {
          for (const filePath of Object.keys(asRecord(payload.changes) ?? {})) {
            turns.addFilePath(filePath, position);
          }
        }
        return;
      }
      if (type !== "response_item") {
        if (!IGNORED_LINE_TYPES.has(type)) {
          countUnknownLine(diagnostics, type);
        }
        return;
      }

      const itemType = asString(payload.type) ?? "(none)";
      if (!KNOWN_RESPONSE_ITEMS.has(itemType)) {
        countUnknownLine(diagnostics, `response_item.${itemType}`);
        return;
      }
      if (itemType === "message") {
        if (payload.role === "user") {
          const text = cleanCodexUserContent(payload.content);
          if (text.length > 0) {
            turns.startTurn(text, position);
          }
        } else if (payload.role === "assistant") {
          turns.addAssistantText(
            assistantContentText(payload.content),
            position,
          );
        }
        return;
      }
      if (
        itemType === "function_call" ||
        itemType === "custom_tool_call" ||
        itemType === "local_shell_call"
      ) {
        recordToolCall(payload, turns, position);
      }
    },
  );

  const sessionMeta = state.meta;
  const nativeId =
    sessionMeta?.id ??
    path.basename(source.path).match(ROLLOUT_ID)?.[1] ??
    null;
  if (!readable || nativeId === null) {
    return { conversation: null, diagnostics };
  }

  const cwd = sessionMeta?.cwd ?? state.turnContextCwd;
  const parsedTurns = turns.finish();
  return {
    conversation: {
      agent: "codex",
      nativeId,
      sourcePath: source.path,
      cwd,
      gitBranch: sessionMeta?.gitBranch ?? null,
      gitSha: sessionMeta?.gitSha ?? null,
      title: null,
      startedAtMs: state.startedAtMs,
      updatedAtMs: state.updatedAtMs,
      parentNativeId: sessionMeta?.parentNativeId ?? null,
      relation: sessionMeta?.relation ?? "main",
      origin: classifyOrigin(cwd, parsedTurns, context.textGeneration),
      turns: parsedTurns,
    },
    diagnostics,
  };
}
