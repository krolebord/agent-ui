import spawn from "nano-spawn";
import log from "../../logger";
import {
  generateTitleGenerationPrompt,
  systemPrompt,
} from "../../title-generation-prompts";
import { sanitizeGeneratedTitle } from "../sanitize-title";

export async function generateCursorTitle(
  userPrompt: string,
  model: string,
): Promise<string | null> {
  const prompt = [systemPrompt, generateTitleGenerationPrompt(userPrompt)]
    .filter(Boolean)
    .join("\n\n");

  const args = ["agent", "-p", "--trust", "--model", model, prompt];

  try {
    const { output } = await spawn("cursor", args, {
      preferLocal: true,
      timeout: 30_000,
      stdin: "ignore",
    });
    const title = sanitizeGeneratedTitle(output);
    log.info("Cursor title generation: success", { title, model });
    return title;
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
      model,
    });
    return null;
  }
}
