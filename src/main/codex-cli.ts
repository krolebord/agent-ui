import { shellQuote } from "@shared/utils";
import type {
  CodexFastMode,
  CodexModelReasoningEffort,
  CodexPermissionMode,
} from "../shared/codex-types";

export interface BuildCodexArgsInput {
  permissionMode: CodexPermissionMode;
  model?: string;
  modelReasoningEffort?: CodexModelReasoningEffort;
  fastMode?: CodexFastMode;
  configOverrides?: string;
  initialPrompt?: string;
  resumeSessionId?: string;
}

export function buildCodexArgs(input: BuildCodexArgsInput): { args: string[] } {
  const args: string[] = input.resumeSessionId
    ? ["resume", input.resumeSessionId, "--no-alt-screen"]
    : ["--no-alt-screen"];

  if (input.permissionMode === "full-auto") {
    args.push("--full-auto");
  } else if (input.permissionMode === "yolo") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }

  const model = input.model?.trim() || "gpt-5.3-codex";
  args.push("--model", model);

  if (input.fastMode === "fast") {
    args.push("--enable", "fast_mode");
  } else if (input.fastMode === "off") {
    args.push("--disable", "fast_mode");
  }

  const modelReasoningEffort = input.modelReasoningEffort ?? "high";
  args.push("-c", `model_reasoning_effort=${modelReasoningEffort}`);
  if (input.fastMode === "fast") {
    args.push("-c", "service_tier=fast");
  }

  if (input.configOverrides?.trim()) {
    for (const line of input.configOverrides.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) {
        args.push("--config", trimmed);
      }
    }
  }

  if (!input.resumeSessionId && input.initialPrompt?.trim()) {
    args.push(shellQuote(input.initialPrompt));
  }

  return { args };
}
