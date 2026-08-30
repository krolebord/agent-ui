import type { TitleGenerationSettings } from "@shared/title-generation";
import { generateCodexTitle } from "./providers/codex";
import { generateCursorTitle } from "./providers/cursor";

export async function generateTitle(
  settings: TitleGenerationSettings,
  userPrompt: string,
  workingDirectory: string,
): Promise<string | null> {
  switch (settings.provider) {
    case "codex":
      return generateCodexTitle(userPrompt, settings.model, workingDirectory);
    case "cursor":
      return generateCursorTitle(userPrompt, settings.model);
  }
}
