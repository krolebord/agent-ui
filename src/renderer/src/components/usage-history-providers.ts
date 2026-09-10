import type { UsageHistoryProvider } from "@shared/usage-history";
import {
  ClaudeCodeIcon,
  CodexIcon,
  CursorAgentIcon,
  type SessionTypeIcon,
} from "./session-type-icons";

interface UsageProviderPresentation {
  label: string;
  color: string;
  mark: SessionTypeIcon;
}

export const USAGE_PROVIDER_PRESENTATION = {
  claude: {
    label: "Claude Code",
    color: "#d97757",
    mark: ClaudeCodeIcon,
  },
  codex: {
    label: "Codex",
    color: "var(--foreground)",
    mark: CodexIcon,
  },
  cursor: {
    label: "Cursor",
    color: "#3b82f6",
    mark: CursorAgentIcon,
  },
} satisfies Record<UsageHistoryProvider, UsageProviderPresentation>;
