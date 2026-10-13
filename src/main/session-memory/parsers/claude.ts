import path from "node:path";
import { z } from "zod";
import {
  asRecord,
  asString,
  parseTimestampMs,
} from "../../agent-transcripts/json";
import { ClaudeForkFinder, LeadingRun } from "./claude-forks";
import {
  countUnknownLine,
  emptyDiagnostics,
  readJsonFile,
  readJsonlRecords,
} from "./read";
import { extractTagContents, removeTaggedBlocks, tidyText } from "./text";
import { classifyOrigin } from "./text-generation";
import { TurnCollector, type TurnPosition } from "./turns";
import type { ParseContext, ParseOutcome, TranscriptSource } from "./types";

const CONTENT_LINE_TYPES = new Set(["user", "assistant", "attachment"]);

const IGNORED_LINE_TYPES = new Set([
  "system",
  "permission-mode",
  "mode",
  "atis-latch",
  "last-prompt",
  "file-history-snapshot",
  "file-history-delta",
  "cost-state",
  "queue-operation",
  "isolation-latch",
  "fork-context-ref",
  "pr-link",
  "progress",
  "agent-name",
  "tag",
]);

const DROPPED_USER_BLOCKS = [
  "system-reminder",
  "task-notification",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
  "fork-boilerplate",
  "bash-stdout",
  "bash-stderr",
  "command-message",
  "command-name",
  "command-args",
  "command-contents",
];

const INTERRUPTION_MARKER = /\[Request interrupted by user[^\]]*\]/g;

const FILE_TOOLS = new Set([
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "NotebookRead",
]);

const subagentMetaSchema = z.object({
  description: z.string().optional().catch(undefined),
});

type ClaudeEvent =
  | { kind: "user"; text: string }
  | {
      kind: "assistant";
      texts: string[];
      filePaths: string[];
      commands: string[];
    };

interface ClaudeNode {
  uuid: string | null;
  parentUuid: string | null;
  line: number;
  timestampMs: number | null;
  /** User or assistant line, eligible as the conversation leaf. */
  isMessage: boolean;
  /** Copied from the parent transcript when this session was forked. */
  copied: boolean;
  event: ClaudeEvent | null;
}

export function cleanClaudeUserText(raw: string): string {
  const commandName = extractTagContents(raw, "command-name")[0]?.trim();
  const commandArgs = extractTagContents(raw, "command-args")[0]?.trim();
  let text = removeTaggedBlocks(raw, DROPPED_USER_BLOCKS);
  const bashInputs = extractTagContents(text, "bash-input");
  if (bashInputs.length > 0) {
    text = removeTaggedBlocks(text, ["bash-input"]);
    text = `${bashInputs.map((input) => `! ${input.trim()}`).join("\n")}\n${text}`;
  }
  if (commandName) {
    text = `${[commandName, commandArgs].filter(Boolean).join(" ")}\n${text}`;
  }
  return tidyText(text.replace(INTERRUPTION_MARKER, ""));
}

function messageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  return parts.join("\n\n");
}

function assistantEvent(content: unknown): ClaudeEvent {
  const texts: string[] = [];
  const filePaths: string[] = [];
  const commands: string[] = [];
  const blocks =
    typeof content === "string" ? [{ type: "text", text: content }] : content;
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const record = asRecord(block);
    if (record?.type === "text" && typeof record.text === "string") {
      texts.push(record.text);
      continue;
    }
    const name = record?.type === "tool_use" ? asString(record.name) : null;
    const input = asRecord(record?.input);
    if (name === null || input === null) {
      continue;
    }
    if (FILE_TOOLS.has(name)) {
      const filePath =
        asString(input.file_path) ?? asString(input.notebook_path);
      if (filePath !== null) {
        filePaths.push(filePath);
      }
    } else if (name === "Bash") {
      const command = asString(input.command);
      if (command !== null) {
        commands.push(command);
      }
    }
  }
  return { kind: "assistant", texts, filePaths, commands };
}

function queuedPromptEvent(
  attachment: Record<string, unknown>,
): ClaudeEvent | null {
  if (attachment.type !== "queued_command") {
    return null;
  }
  const origin = asString(asRecord(attachment.origin)?.kind);
  if (origin !== "human" && attachment.commandMode !== "prompt") {
    return null;
  }
  return {
    kind: "user",
    text: cleanClaudeUserText(messageText(attachment.prompt)),
  };
}

/** Keeps the branch that ends at the last message, so rewound branches drop out. */
function activeLines(nodes: ClaudeNode[]): (node: ClaudeNode) => boolean {
  const byUuid = new Map<string, ClaudeNode>();
  for (const node of nodes) {
    if (node.uuid !== null) {
      byUuid.set(node.uuid, node);
    }
  }
  const leaf = nodes.findLast((node) => node.isMessage && node.uuid !== null);
  if (leaf === undefined) {
    return () => true;
  }
  const active = new Set<string>();
  let brokenBeforeLine = 0;
  let current: ClaudeNode | undefined = leaf;
  while (current?.uuid && !active.has(current.uuid)) {
    active.add(current.uuid);
    if (current.parentUuid === null) {
      break;
    }
    const parent = byUuid.get(current.parentUuid);
    if (parent === undefined) {
      brokenBeforeLine = current.line;
      break;
    }
    current = parent;
  }
  return (node) =>
    node.uuid === null || active.has(node.uuid) || node.line < brokenBeforeLine;
}

interface ClaudeFileShape {
  nativeId: string;
  parentNativeId: string | null;
}

function fileShape(sourcePath: string): ClaudeFileShape {
  const stem = path.basename(sourcePath, ".jsonl");
  const parentDir = path.dirname(sourcePath);
  if (path.basename(parentDir) === "subagents") {
    return {
      nativeId: stem.replace(/^agent-/, ""),
      parentNativeId: path.basename(path.dirname(parentDir)),
    };
  }
  return { nativeId: stem, parentNativeId: null };
}

export async function parseClaudeTranscript(
  source: TranscriptSource,
  context: ParseContext,
): Promise<ParseOutcome> {
  const diagnostics = emptyDiagnostics();
  const shape = fileShape(source.path);
  const isSubagent = shape.parentNativeId !== null;
  const nodes: ClaudeNode[] = [];
  const leadingRun = new LeadingRun();
  const state: {
    cwd: string | null;
    gitBranch: string | null;
    title: string | null;
    customTitle: string | null;
    branchedFrom: string | null;
  } = {
    cwd: null,
    gitBranch: null,
    title: null,
    customTitle: null,
    branchedFrom: null,
  };

  const readable = await readJsonlRecords(
    source.path,
    diagnostics,
    (record, line) => {
      leadingRun.add(record);
      const type = asString(record.type) ?? "(none)";
      if (type === "summary") {
        state.title = asString(record.summary) ?? state.title;
        return;
      }
      if (type === "custom-title") {
        state.customTitle = asString(record.customTitle) ?? state.customTitle;
        return;
      }
      const hasContent = CONTENT_LINE_TYPES.has(type);
      if (!hasContent && !IGNORED_LINE_TYPES.has(type)) {
        countUnknownLine(diagnostics, type);
      }
      if (record.isSidechain === true && !isSubagent) {
        return;
      }
      const uuid = asString(record.uuid);
      const parentUuid =
        asString(record.parentUuid) ?? asString(record.logicalParentUuid);
      const branchedFrom = asString(asRecord(record.forkedFrom)?.sessionId);
      if (branchedFrom !== null) {
        state.branchedFrom ??= branchedFrom;
      }
      const copied = branchedFrom !== null;
      if (!hasContent) {
        if (uuid !== null) {
          nodes.push({
            uuid,
            parentUuid,
            line,
            timestampMs: null,
            isMessage: false,
            copied,
            event: null,
          });
        }
        return;
      }

      state.cwd ??= asString(record.cwd) || null;
      state.gitBranch = asString(record.gitBranch) || state.gitBranch;

      const message = asRecord(record.message);
      let event: ClaudeEvent | null = null;
      if (type === "user") {
        if (record.isMeta !== true && record.isCompactSummary !== true) {
          event = {
            kind: "user",
            text: cleanClaudeUserText(messageText(message?.content)),
          };
        }
      } else if (type === "assistant") {
        if (message?.model !== "<synthetic>") {
          event = assistantEvent(message?.content);
        }
      } else {
        const attachment = asRecord(record.attachment);
        event = attachment === null ? null : queuedPromptEvent(attachment);
      }

      nodes.push({
        uuid,
        parentUuid,
        line,
        timestampMs: parseTimestampMs(record.timestamp),
        isMessage: type !== "attachment",
        copied,
        event,
      });
    },
  );
  if (!readable) {
    return { conversation: null, diagnostics };
  }

  let forkParent = state.branchedFrom;
  if (!isSubagent && forkParent === null) {
    const finder = context.claudeForks ?? new ClaudeForkFinder();
    const found = await finder.find(source.path, leadingRun.uuids);
    if (found !== null) {
      forkParent = found.nativeId;
      for (const node of nodes) {
        if (node.uuid !== null && found.copiedUuids.has(node.uuid)) {
          node.copied = true;
        }
      }
    }
  }

  const isActive = activeLines(nodes);
  const turns = new TurnCollector();
  let startedAtMs: number | null = null;
  let updatedAtMs: number | null = null;
  for (const node of nodes) {
    if (node.timestampMs !== null) {
      updatedAtMs = node.timestampMs;
      if (!node.copied) {
        startedAtMs ??= node.timestampMs;
      }
    }
    if (node.event === null || node.copied || !isActive(node)) {
      continue;
    }
    const position: TurnPosition = {
      startedAtMs: node.timestampMs,
      line: node.line,
      eventId: node.uuid,
    };
    if (node.event.kind === "user") {
      if (node.event.text.length > 0) {
        turns.startTurn(node.event.text, position);
      }
      continue;
    }
    for (const text of node.event.texts) {
      turns.addAssistantText(text, position);
    }
    for (const filePath of node.event.filePaths) {
      turns.addFilePath(filePath, position);
    }
    for (const command of node.event.commands) {
      turns.addCommand(command, position);
    }
  }

  if (isSubagent) {
    const meta = await readJsonFile(source.metaPath, subagentMetaSchema);
    state.title = meta?.description ?? state.title;
  }

  const parsedTurns = turns.finish();
  return {
    conversation: {
      agent: "claude",
      nativeId: shape.nativeId,
      sourcePath: source.path,
      cwd: state.cwd,
      gitBranch: state.gitBranch,
      gitSha: null,
      title: state.customTitle ?? state.title,
      startedAtMs,
      updatedAtMs,
      parentNativeId: shape.parentNativeId ?? forkParent,
      relation: isSubagent ? "subagent" : forkParent !== null ? "fork" : "main",
      origin: classifyOrigin(state.cwd, parsedTurns, context.textGeneration),
      turns: parsedTurns,
    },
    diagnostics,
  };
}
