import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ParseContext,
  TranscriptAgent,
  TranscriptSource,
} from "../../../../src/main/session-memory/parsers/types";

export const testContext: ParseContext = {
  textGeneration: {
    workspaceDirs: ["/data/agent-ui/text-generation-workspace"],
    excludedCwdPrefixes: ["/install/agent-ui/releases"],
  },
};

export async function makeTempRoot(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(tmpdir(), prefix));
}

export async function writeJsonl(
  filePath: string,
  lines: unknown[],
): Promise<string> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(
    filePath,
    `${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`,
    "utf8",
  );
  return filePath;
}

export async function writeJson(
  filePath: string,
  value: unknown,
): Promise<string> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(value), "utf8");
  return filePath;
}

export async function sourceFor(
  agent: TranscriptAgent,
  filePath: string,
  metaPath: string | null = null,
): Promise<TranscriptSource> {
  const stats = await fsp.stat(filePath);
  return {
    agent,
    path: filePath,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    metaPath,
    metaMtimeMs: null,
    fingerprint: `${stats.size}:${stats.mtimeMs}`,
  };
}
