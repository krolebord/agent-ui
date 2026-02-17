import spawn from "nano-spawn";
import log from "./logger";

const FALLBACK_TITLE = "New Session";

const systemPrompt = `
You are a summarization assistant.
When given a user prompt, you need to summarize it into a very short session title (2-4 words, max 30 characters).
Be extremely concise.
**CRITICAL:** output only the summarized title, nothing else.`;

export async function generateSessionTitle(prompt: string): Promise<string> {
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
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    `User prompt:\n${prompt}`,
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
