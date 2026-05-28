import { createCursorProvider } from "../../llm-providers/cursor";
import {
  generateTitleGenerationPrompt,
  systemPrompt,
} from "../../title-generation-prompts";
import { sanitizeGeneratedTitle } from "../sanitize-title";

export async function generateCursorTitle(
  userPrompt: string,
  model: string,
): Promise<string | null> {
  const provider = createCursorProvider(model);
  const prompt = [systemPrompt, generateTitleGenerationPrompt(userPrompt)]
    .filter(Boolean)
    .join("\n\n");

  const raw = await provider.complete(prompt);
  if (!raw) {
    return null;
  }

  return sanitizeGeneratedTitle(raw);
}
