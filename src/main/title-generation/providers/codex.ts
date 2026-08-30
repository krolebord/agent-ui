import { createCodexProvider } from "../../llm-providers/codex";
import {
  generateTitleGenerationPrompt,
  systemPrompt,
} from "../../title-generation-prompts";
import { sanitizeGeneratedTitle } from "../sanitize-title";

export async function generateCodexTitle(
  userPrompt: string,
  model: string,
  workingDirectory: string,
): Promise<string | null> {
  const provider = createCodexProvider(model, {
    workingDirectory,
    reasoningEffort: "low",
  });
  const prompt = [systemPrompt, generateTitleGenerationPrompt(userPrompt)]
    .filter(Boolean)
    .join("\n\n");

  const raw = await provider.complete(prompt);
  if (!raw) {
    return null;
  }

  return sanitizeGeneratedTitle(raw);
}
