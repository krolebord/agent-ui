import spawn from "nano-spawn";
import log from "../logger";
import type { LlmProvider } from "./types";

export interface CursorProviderOptions {
  timeoutMs?: number;
}

export function createCursorProvider(
  model: string,
  options?: CursorProviderOptions,
): LlmProvider {
  return {
    async complete(prompt: string): Promise<string | null> {
      const args = [
        "agent",
        "-p",
        "--trust",
        "--model",
        model,
        "--mode",
        "ask",
        prompt,
      ];

      try {
        const { output } = await spawn("cursor", args, {
          preferLocal: true,
          timeout: options?.timeoutMs ?? 30_000,
          stdin: "ignore",
        });
        const trimmed = output.trim();
        if (!trimmed) {
          return null;
        }
        log.info("Cursor LLM: success", {
          model,
          outputLength: trimmed.length,
        });
        return trimmed;
      } catch (e: unknown) {
        const err = e as {
          message?: string;
          code?: string;
          stderr?: string;
          exitCode?: number;
        };
        log.error("Cursor LLM: failed", {
          message: err.message,
          code: err.code,
          stderr: err.stderr,
          exitCode: err.exitCode,
          model,
        });
        return null;
      }
    },
  };
}
