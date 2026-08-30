import type { TitleGenerationProvider } from "@shared/title-generation";
import { type CodexProviderOptions, createCodexProvider } from "./codex";
import { createCursorProvider } from "./cursor";
import type { LlmProvider } from "./types";

export type { LlmProvider } from "./types";

export interface LlmProviderSettings {
  provider: TitleGenerationProvider;
  model: string;
}

export function createLlmProvider(
  settings: LlmProviderSettings,
  options: CodexProviderOptions,
): LlmProvider {
  switch (settings.provider) {
    case "codex":
      return createCodexProvider(settings.model, options);
    case "cursor":
      return createCursorProvider(settings.model, {
        timeoutMs: options.timeoutMs,
      });
  }
}
