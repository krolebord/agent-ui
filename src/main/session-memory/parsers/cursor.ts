import path from "node:path";
import { z } from "zod";
import { asRecord, asString } from "../../agent-transcripts/json";
import {
  countUnknownLine,
  emptyDiagnostics,
  readJsonFile,
  readJsonlRecords,
} from "./read";
import { extractTagContents, removeTaggedBlocks, tidyText } from "./text";
import { classifyOrigin } from "./text-generation";
import { commandFromArgv, toolInputRecord } from "./tool-inputs";
import { TurnCollector, type TurnPosition } from "./turns";
import type {
  ParseContext,
  ParseOutcome,
  TextGenerationRules,
  TranscriptSource,
} from "./types";

const DROPPED_USER_BLOCKS = [
  "timestamp",
  "manually_attached_skills",
  "cursor_commands",
  "dynamic_tool_catalog",
  "system_reminder",
];

const FILE_TOOLS = new Set([
  "Read",
  "Write",
  "StrReplace",
  "Edit",
  "MultiEdit",
  "Delete",
  "EditNotebook",
]);

const SHELL_TOOLS = new Set(["Shell", "Bash"]);

const REDACTED_LINE = /^\[REDACTED\]$/gm;

const cursorChatMetaSchema = z.object({
  cwd: z.string().optional().catch(undefined),
  title: z.string().optional().catch(undefined),
  createdAtMs: z.number().optional().catch(undefined),
  updatedAtMs: z.number().optional().catch(undefined),
});

export interface CursorUserMessage {
  text: string;
  timestampMs: number | null;
}

function parseCursorTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value.replace(/\(UTC\)/, "UTC"));
  return Number.isNaN(parsed) ? null : parsed;
}

export function cleanCursorUserText(raw: string): CursorUserMessage {
  const timestampMs = parseCursorTimestamp(
    extractTagContents(raw, "timestamp")[0],
  );
  const queries = extractTagContents(raw, "user_query");
  const body = queries.length > 0 ? queries.join("\n\n") : raw;
  return {
    text: tidyText(removeTaggedBlocks(body, DROPPED_USER_BLOCKS)),
    timestampMs,
  };
}

function contentBlocks(record: Record<string, unknown>): unknown[] {
  const content = asRecord(record.message)?.content;
  return Array.isArray(content) ? content : [];
}

/** Matches the directory naming under `~/.cursor/projects`. */
export function cursorProjectSlug(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function projectSlugMatchesTextGeneration(
  transcriptPath: string,
  rules: TextGenerationRules,
): boolean {
  const projectDir = path.basename(
    path.dirname(path.dirname(path.dirname(transcriptPath))),
  );
  return [...rules.workspaceDirs, ...rules.excludedCwdPrefixes].some((dir) => {
    const slug = cursorProjectSlug(dir);
    return projectDir === slug || projectDir.startsWith(`${slug}-`);
  });
}

function recordToolUse(
  block: Record<string, unknown>,
  turns: TurnCollector,
  position: TurnPosition,
): void {
  const name = asString(block.name);
  const input = toolInputRecord(block.input);
  if (name === null || input === null) {
    return;
  }
  if (FILE_TOOLS.has(name)) {
    turns.addFilePath(
      asString(input.path) ??
        asString(input.file_path) ??
        asString(input.target_file),
      position,
    );
  } else if (SHELL_TOOLS.has(name)) {
    turns.addCommand(commandFromArgv(input.command), position);
  }
}

export async function parseCursorTranscript(
  source: TranscriptSource,
  context: ParseContext,
): Promise<ParseOutcome> {
  const diagnostics = emptyDiagnostics();
  const turns = new TurnCollector();
  const timestamps: { first: number | null; last: number | null } = {
    first: null,
    last: null,
  };

  const readable = await readJsonlRecords(
    source.path,
    diagnostics,
    (record, line) => {
      const role = asString(record.role);
      if (role === null) {
        const type = asString(record.type) ?? "(none)";
        if (type !== "turn_ended") {
          countUnknownLine(diagnostics, type);
        }
        return;
      }
      if (role === "user") {
        const raw = contentBlocks(record)
          .map((block) => {
            const value = asRecord(block);
            return value?.type === "text" ? (asString(value.text) ?? "") : "";
          })
          .join("\n\n");
        const message = cleanCursorUserText(raw);
        if (message.timestampMs !== null) {
          timestamps.last = message.timestampMs;
          timestamps.first ??= message.timestampMs;
        }
        if (message.text.length > 0) {
          turns.startTurn(message.text, {
            startedAtMs: message.timestampMs,
            line,
            eventId: null,
          });
        }
        return;
      }
      if (role !== "assistant") {
        countUnknownLine(diagnostics, `role.${role}`);
        return;
      }
      const position: TurnPosition = {
        startedAtMs: timestamps.last,
        line,
        eventId: null,
      };
      for (const block of contentBlocks(record)) {
        const value = asRecord(block);
        if (value?.type === "text") {
          turns.addAssistantText(
            (asString(value.text) ?? "").replace(REDACTED_LINE, ""),
            position,
          );
        } else if (value?.type === "tool_use") {
          recordToolUse(value, turns, position);
        }
      }
    },
  );
  if (!readable) {
    return { conversation: null, diagnostics };
  }

  const meta = await readJsonFile(source.metaPath, cursorChatMetaSchema);
  const cwd = meta?.cwd || null;
  const parsedTurns = turns.finish();
  let origin = classifyOrigin(cwd, parsedTurns, context.textGeneration);
  if (
    origin === "user" &&
    cwd === null &&
    projectSlugMatchesTextGeneration(source.path, context.textGeneration)
  ) {
    origin = "text-generation";
  }

  return {
    conversation: {
      agent: "cursor",
      nativeId: path.basename(source.path, ".jsonl"),
      sourcePath: source.path,
      cwd,
      gitBranch: null,
      gitSha: null,
      title: meta?.title?.trim() || null,
      startedAtMs: meta?.createdAtMs ?? timestamps.first,
      updatedAtMs: meta?.updatedAtMs ?? source.mtimeMs,
      parentNativeId: null,
      relation: "main",
      origin,
      turns: parsedTurns,
    },
    diagnostics,
  };
}
