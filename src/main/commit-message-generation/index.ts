import type { GeneratedCommitMessage } from "@shared/commit-message-generation";
import type { TitleGenerationSettings } from "@shared/title-generation";
import { createLlmProvider } from "../llm-providers";
import { parseGeneratedCommitMessage } from "./parse-commit-message";
import { generateCommitMessagePrompt } from "./prompts";
import { truncateDiffForCommitMessage } from "./truncate-diff";

const commitMessageTimeoutMs = 60_000;

export async function generateCommitMessage(
  settings: TitleGenerationSettings,
  diff: string,
): Promise<GeneratedCommitMessage | null> {
  const trimmedDiff = diff.trim();
  if (!trimmedDiff) {
    return null;
  }

  const provider = createLlmProvider(settings, {
    timeoutMs: commitMessageTimeoutMs,
  });
  const prompt = generateCommitMessagePrompt(
    truncateDiffForCommitMessage(trimmedDiff),
  );
  const raw = await provider.complete(prompt);
  if (!raw) {
    return null;
  }

  return parseGeneratedCommitMessage(raw);
}
