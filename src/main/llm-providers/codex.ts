import { mkdir } from "node:fs/promises";
import type { CodexModelReasoningEffort } from "@shared/codex-types";
import spawn from "nano-spawn";
import z from "zod";
import log from "../logger";
import type { LlmProvider } from "./types";

const codexAgentMessageEventSchema = z.object({
  type: z.literal("item.completed"),
  item: z.object({
    type: z.literal("agent_message"),
    text: z.string(),
  }),
});

export interface CodexProviderOptions {
  workingDirectory: string;
  reasoningEffort: CodexModelReasoningEffort;
  timeoutMs?: number;
}

export function buildCodexTextGenerationArgs(input: {
  model: string;
  reasoningEffort: CodexModelReasoningEffort;
  workingDirectory: string;
}): string[] {
  return [
    "-a",
    "never",
    "--disable",
    "plugins",
    "--disable",
    "remote_plugin",
    "--disable",
    "apps",
    "--disable",
    "multi_agent",
    "exec",
    "--strict-config",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "-C",
    input.workingDirectory,
    "-s",
    "read-only",
    "-m",
    input.model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`,
    "-c",
    'model_verbosity="low"',
    "-c",
    'service_tier="default"',
    "--json",
    "-",
  ];
}

export function parseCodexTextGenerationOutput(output: string): string | null {
  let lastMessage: string | null = null;

  for (const line of output.split(/\r?\n/u)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(trimmedLine);
      const event = codexAgentMessageEventSchema.safeParse(parsed);
      if (event.success && event.data.item.text.trim()) {
        lastMessage = event.data.item.text.trim();
      }
    } catch {
      // Codex JSON mode should emit JSONL, but an unrelated warning must not
      // turn a valid agent message elsewhere in the stream into a failure.
    }
  }

  return lastMessage;
}

export function createCodexProvider(
  model: string,
  options: CodexProviderOptions,
): LlmProvider {
  return {
    async complete(prompt: string): Promise<string | null> {
      try {
        await mkdir(options.workingDirectory, { recursive: true });
        const args = buildCodexTextGenerationArgs({
          model,
          reasoningEffort: options.reasoningEffort,
          workingDirectory: options.workingDirectory,
        });
        const { stdout } = await spawn("codex", args, {
          cwd: options.workingDirectory,
          preferLocal: true,
          timeout: options.timeoutMs ?? 30_000,
          stdin: { string: prompt },
        });
        const result = parseCodexTextGenerationOutput(stdout);
        if (!result) {
          return null;
        }
        log.info("Codex LLM: success", {
          model,
          reasoningEffort: options.reasoningEffort,
          outputLength: result.length,
        });
        return result;
      } catch (error) {
        log.error("Codex LLM: failed", {
          error,
          model,
          reasoningEffort: options.reasoningEffort,
        });
        return null;
      }
    },
  };
}
