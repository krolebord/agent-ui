import * as fsp from "node:fs/promises";
import type { z } from "zod";
import { parseJsonRecord } from "../../agent-transcripts/json";
import { forEachLine } from "../../agent-transcripts/jsonl";
import type { ParseDiagnostics } from "./types";

export function emptyDiagnostics(): ParseDiagnostics {
  return { lines: 0, malformedLines: 0, unknownLineTypes: {}, readError: null };
}

export function countUnknownLine(
  diagnostics: ParseDiagnostics,
  type: string,
): void {
  diagnostics.unknownLineTypes[type] =
    (diagnostics.unknownLineTypes[type] ?? 0) + 1;
}

/** Feeds each JSON object line to `visit`. Returns false when the file could not be read. */
export async function readJsonlRecords(
  filePath: string,
  diagnostics: ParseDiagnostics,
  visit: (record: Record<string, unknown>, lineNumber: number) => void,
): Promise<boolean> {
  try {
    await forEachLine(filePath, (line, lineNumber) => {
      if (line.trim().length === 0) {
        return;
      }
      diagnostics.lines += 1;
      const record = parseJsonRecord(line);
      if (record === null) {
        diagnostics.malformedLines += 1;
        return;
      }
      visit(record, lineNumber);
    });
    return true;
  } catch (error) {
    diagnostics.readError =
      error instanceof Error ? error.message : String(error);
    return false;
  }
}

export async function readJsonFile<T>(
  filePath: string | null,
  schema: z.ZodType<T>,
): Promise<T | null> {
  if (filePath === null) {
    return null;
  }
  try {
    const parsed = schema.safeParse(
      JSON.parse(await fsp.readFile(filePath, "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
