import type {
  CursorAgentMode,
  CursorAgentPermissionMode,
} from "@shared/claude-types";
import { shellQuote } from "@shared/utils";

export type { CursorAgentMode, CursorAgentPermissionMode };

export interface BuildCursorAgentArgsInput {
  cursorChatId?: string;
  cwd: string;
  model?: string;
  mode?: CursorAgentMode;
  permissionMode: CursorAgentPermissionMode;
  initialPrompt?: string;
  plan?: boolean;
}

export function buildCursorAgentArgs(input: BuildCursorAgentArgsInput): {
  args: string[];
} {
  const args: string[] = ["agent"];

  if (input.cursorChatId) {
    args.push("--resume", input.cursorChatId);
  }
  args.push("--workspace", input.cwd);

  if (input.model?.trim()) {
    args.push("--model", input.model.trim());
  }

  if (input.mode) {
    args.push("--mode", input.mode);
  }

  if (input.permissionMode === "yolo") {
    args.push("--yolo");
  }

  if (input.initialPrompt?.trim()) {
    if (input.plan) {
      args.push("--plan");
    }
    args.push(shellQuote(input.initialPrompt));
  }

  return { args };
}
