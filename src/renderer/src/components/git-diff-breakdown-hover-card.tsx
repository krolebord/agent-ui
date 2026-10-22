import { orpc } from "@renderer/orpc-client";
import {
  type ChangedFileKind,
  changedFileKinds,
  type GitDiffBreakdown,
} from "@shared/changed-file-kind";
import type { GitDiffStats } from "@shared/claude-types";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";

const KIND_LABELS = {
  code: "Code",
  tests: "Tests",
  evals: "Evals",
  mocks: "Mocks",
  generated: "Generated",
  docs: "Docs",
} satisfies Record<ChangedFileKind, string>;

export function GitDiffBreakdownHoverCard({
  projectPath,
  children,
}: {
  projectPath: string;
  children: ReactNode;
}) {
  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent side="bottom" className="w-auto px-3 py-2 text-xs">
        <GitDiffBreakdownContent projectPath={projectPath} />
      </HoverCardContent>
    </HoverCard>
  );
}

function GitDiffBreakdownContent({ projectPath }: { projectPath: string }) {
  const { data, isPending } = useQuery(
    orpc.projects.getDiffBreakdown.queryOptions({
      input: { path: projectPath },
    }),
  );

  if (!data) {
    return (
      <span className="text-muted-foreground">
        {isPending ? "Loading breakdown…" : "No breakdown available"}
      </span>
    );
  }

  return <GitDiffBreakdownGrid breakdown={data} />;
}

function GitDiffBreakdownGrid({ breakdown }: { breakdown: GitDiffBreakdown }) {
  const total: GitDiffStats = { addedLines: 0, deletedLines: 0 };
  for (const kind of changedFileKinds) {
    total.addedLines += breakdown[kind].addedLines;
    total.deletedLines += breakdown[kind].deletedLines;
  }

  return (
    <div className="grid grid-cols-[auto_auto_auto] gap-x-4 gap-y-1 font-mono tabular-nums">
      {changedFileKinds.map((kind) => {
        const stats = breakdown[kind];
        return stats.addedLines === 0 && stats.deletedLines === 0 ? null : (
          <BreakdownRow key={kind} label={KIND_LABELS[kind]} stats={stats} />
        );
      })}
      <div className="col-span-3 border-t border-border" />
      <BreakdownRow label="Total" stats={total} />
    </div>
  );
}

function BreakdownRow({
  label,
  stats,
}: {
  label: string;
  stats: GitDiffStats;
}) {
  return (
    <>
      <span className="font-sans">{label}</span>
      <span className="text-right text-emerald-400">+{stats.addedLines}</span>
      <span className="text-right text-rose-400">-{stats.deletedLines}</span>
    </>
  );
}
