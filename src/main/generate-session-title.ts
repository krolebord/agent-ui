import spawn from "nano-spawn";
import log from "./logger";
import {
  generateTitleGenerationPrompt,
  systemPrompt,
} from "./title-generation-prompts";

const FALLBACK_TITLE = "New Session";

export async function generateSessionTitle(
  userPrompt: string,
): Promise<string> {
  const prompt = generateTitleGenerationPrompt(userPrompt);
  const args = [
    "--system-prompt",
    systemPrompt,
    "--print",
    "--model",
    "haiku",
    "--fallback-model",
    "sonnet",
    "--no-chrome",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    prompt,
  ];

  try {
    const { output } = await spawn("claude", args, {
      preferLocal: true,
      timeout: 10_000,
      stdin: "ignore",
    });
    const title = output.trim();
    log.info("Title generation: success", { title: title || FALLBACK_TITLE });
    return title || FALLBACK_TITLE;
  } catch (e: unknown) {
    const err = e as {
      message?: string;
      code?: string;
      stderr?: string;
      exitCode?: number;
    };
    log.error("Title generation: failed", {
      message: err.message,
      code: err.code,
      stderr: err.stderr,
      exitCode: err.exitCode,
    });
    return FALLBACK_TITLE;
  }
}
