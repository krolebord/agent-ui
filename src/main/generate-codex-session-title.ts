import spawn from "nano-spawn";
import log from "./logger";

const FALLBACK_TITLE = "Codex Session";

function buildTitlePrompt(userPrompt: string): string {
  return [
    "Generate a concise session title for this prompt.",
    "Rules:",
    "- 2 to 4 words",
    "- max 30 characters",
    "- plain text only",
    "- output only the title",
    "",
    "Prompt:",
    userPrompt,
  ].join("\n");
}

export async function generateCodexSessionTitle(
  userPrompt: string,
): Promise<string> {
  const args = [
    "exec",
    "--model",
    "gpt-5.1-codex-mini",
    "--ephemeral",
    "--color",
    "never",
    "--skip-git-repo-check",
    "-c",
    "hide_agent_reasoning=true",
    "-c",
    "model_reasoning_summary=none",
    "-c",
    "suppress_unstable_features_warning=true",
    buildTitlePrompt(userPrompt),
  ];

  try {
    const { stdout } = await spawn("codex", args, {
      preferLocal: true,
      timeout: 10_000,
      stdin: "ignore",
    });
    const title =
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "";

    if (!title) {
      log.warn("Codex title generation returned empty output");
      return FALLBACK_TITLE;
    }

    log.info("Codex title generation succeeded", { title });
    return title;
  } catch (e: unknown) {
    const err = e as {
      message?: string;
      code?: string;
      stderr?: string;
      exitCode?: number;
    };
    log.error("Codex title generation failed", {
      message: err.message,
      code: err.code,
      stderr: err.stderr,
      exitCode: err.exitCode,
    });
    return FALLBACK_TITLE;
  }
}
