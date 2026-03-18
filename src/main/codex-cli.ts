import { shellQuote } from "@shared/utils";
import type {
  CodexModelReasoningEffort,
  CodexPermissionMode,
} from "../shared/codex-types";

export interface BuildCodexArgsInput {
  permissionMode: CodexPermissionMode;
  model?: string;
  modelReasoningEffort?: CodexModelReasoningEffort;
  fastMode?: boolean;
  configOverrides?: string;
  initialPrompt?: string;
}

export function buildCodexArgs(input: BuildCodexArgsInput): { args: string[] } {
  const args: string[] = ["--no-alt-screen"];

  if (input.permissionMode === "full-auto") {
    args.push("--full-auto");
  } else if (input.permissionMode === "yolo") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }

  const model = input.model?.trim() || "gpt-5.3-codex";
  args.push("--model", model);

  args.push("--enable", "fast_mode");

  const modelReasoningEffort = input.modelReasoningEffort ?? "high";
  args.push("-c", `model_reasoning_effort=${modelReasoningEffort}`);
  args.push("-c", `service_tier=${input.fastMode ? "fast" : "flex"}`);

  if (input.configOverrides?.trim()) {
    for (const line of input.configOverrides.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) {
        args.push("--config", trimmed);
      }
    }
  }

  if (input.initialPrompt?.trim()) {
    args.push(shellQuote(input.initialPrompt));
  }

  return { args };
}
