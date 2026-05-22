import type { TitleGenerationSettings } from "@shared/title-generation";
import { generateCursorTitle } from "./providers/cursor";

export async function generateTitle(
  settings: TitleGenerationSettings,
  userPrompt: string,
): Promise<string | null> {
  switch (settings.provider) {
    case "cursor":
      return generateCursorTitle(userPrompt, settings.model);
  }
}
