import spawn from "nano-spawn";
import log from "./logger";
import {
  generateTitleGenerationPrompt,
  systemPrompt,
} from "./title-generation-prompts";

const FALLBACK_TITLE = "New Session";

export async function generateCursorSessionTitle(
  userPrompt: string,
): Promise<string> {
  const prompt = [systemPrompt, generateTitleGenerationPrompt(userPrompt)]
    .filter(Boolean)
    .join("\n\n");

  const args = ["agent", "-p", "--trust", "--model", "composer-1", prompt];

  try {
    const { output } = await spawn("cursor", args, {
      preferLocal: true,
      timeout: 10_000,
      stdin: "ignore",
    });
    const title = output.trim();
    log.info("Cursor title generation: success", {
      title: title || FALLBACK_TITLE,
    });
    return title || FALLBACK_TITLE;
  } catch (e: unknown) {
    const err = e as {
      message?: string;
      code?: string;
      stderr?: string;
      exitCode?: number;
    };
    log.error("Cursor title generation: failed", {
      message: err.message,
      code: err.code,
      stderr: err.stderr,
      exitCode: err.exitCode,
    });
    return FALLBACK_TITLE;
  }
}
