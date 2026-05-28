import type { TitleGenerationProvider } from "@shared/title-generation";
import { type CursorProviderOptions, createCursorProvider } from "./cursor";
import type { LlmProvider } from "./types";

export type { LlmProvider } from "./types";

export interface LlmProviderSettings {
  provider: TitleGenerationProvider;
  model: string;
}

export function createLlmProvider(
  settings: LlmProviderSettings,
  options?: CursorProviderOptions,
): LlmProvider {
  switch (settings.provider) {
    case "cursor":
      return createCursorProvider(settings.model, options);
  }
}
