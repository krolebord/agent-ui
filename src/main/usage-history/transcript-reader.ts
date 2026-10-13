import type { UsageHistoryProvider } from "@shared/usage-history";
import { forEachLine } from "../agent-transcripts/jsonl";
import {
  initialCodexScanState,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  type UsageRecord,
} from "./transcripts";

export async function readTranscriptRecords(
  filePath: string,
  provider: UsageHistoryProvider,
): Promise<UsageRecord[] | null> {
  const codexState = initialCodexScanState();
  const records: UsageRecord[] = [];

  const parseLine = (line: string): void => {
    if (provider === "codex") {
      if (
        !mightCarryUsage(line, provider) &&
        !line.includes('"turn_context"') &&
        !line.includes('"session_meta"')
      ) {
        return;
      }
      const record = parseCodexLine(line, codexState);
      if (record) {
        records.push(record);
      }
      return;
    }
    if (!mightCarryUsage(line, provider)) {
      return;
    }
    const record = parseClaudeLine(line);
    if (record) {
      records.push(record);
    }
  };

  try {
    await forEachLine(filePath, parseLine);
  } catch {
    return null;
  }

  return records;
}
