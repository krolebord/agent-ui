import type { GitDiffStats } from "@shared/claude-types";
import { Repeat, TerminalSquare } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import type { Session } from "src/main/sessions/state";
import {
  ClaudeCodeIcon,
  CodexIcon,
  CursorAgentIcon,
} from "./session-type-icons";

const sessionTypeConfig: Record<
  Session["type"],
  { icon: ComponentType<SVGProps<SVGSVGElement>> }
> = {
  "claude-local-terminal": { icon: ClaudeCodeIcon },
  "local-terminal": { icon: TerminalSquare },
  "ralph-loop": { icon: Repeat },
  "codex-local-terminal": { icon: CodexIcon },
  "cursor-agent": { icon: CursorAgentIcon },
};

export function SessionHeader({
  sessionType,
  title,
  gitBranch,
  gitDiffStats,
}: {
  sessionType: Session["type"];
  title: string;
  gitBranch?: string;
  gitDiffStats?: GitDiffStats;
}) {
  const Icon = sessionTypeConfig[sessionType]?.icon;

  return (
    <header className="flex min-h-11 shrink-0 items-center gap-3 border-b border-border/70 px-2 py-1.5">
      {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" /> : null}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{title}</div>
        {gitBranch ? (
          <div className="truncate text-xs text-muted-foreground">
            {gitBranch}
          </div>
        ) : null}
      </div>
      {gitDiffStats ? (
        <div className="shrink-0 font-mono text-xs text-muted-foreground">
          <span className="text-emerald-400">+{gitDiffStats.addedLines}</span>
          <span className="ml-2 text-rose-400">
            -{gitDiffStats.deletedLines}
          </span>
        </div>
      ) : null}
    </header>
  );
}
