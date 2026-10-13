import { parseClaudeTranscript } from "./claude";
import { parseCodexTranscript } from "./codex";
import { parseCursorTranscript } from "./cursor";
import type { ParseContext, ParseOutcome, TranscriptSource } from "./types";

export { ClaudeForkFinder } from "./claude-forks";
export { discoverTranscriptSources } from "./discovery";
export {
  createTextGenerationRules,
  resolveHeadlessInstallRoot,
} from "./text-generation";
export type * from "./types";
export { TRANSCRIPT_PARSER_VERSION } from "./version";

/** Never throws: unreadable files come back with `conversation: null` and `diagnostics.readError`. */
export async function parseTranscriptSource(
  source: TranscriptSource,
  context: ParseContext,
): Promise<ParseOutcome> {
  switch (source.agent) {
    case "claude":
      return await parseClaudeTranscript(source, context);
    case "codex":
      return await parseCodexTranscript(source, context);
    case "cursor":
      return await parseCursorTranscript(source, context);
    default: {
      const exhaustive: never = source.agent;
      throw new Error(`Unknown transcript agent: ${String(exhaustive)}`);
    }
  }
}
