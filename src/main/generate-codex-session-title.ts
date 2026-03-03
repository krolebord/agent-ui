import spawn from "nano-spawn";
import log from "./logger";
import {
  generateTitleGenerationPrompt,
  systemPrompt,
} from "./title-generation-prompts";

const FALLBACK_TITLE = "Codex Session";

export async function generateCodexSessionTitle(
  userPrompt: string,
): Promise<string> {
  const prompt = [systemPrompt, generateTitleGenerationPrompt(userPrompt)]
    .filter(Boolean)
    .join("\n\n");

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
    "-c",
    "mcp_servers={}",
    prompt,
  ];

  try {
    const { stdout } = await spawn("codex", args, {
      preferLocal: true,
      timeout: 30_000,
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
