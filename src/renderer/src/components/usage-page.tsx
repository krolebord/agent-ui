import { MobileSidebarTrigger } from "@renderer/components/mobile-sidebar-trigger";
import { useAppState } from "@renderer/components/sync-state-provider";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import {
  buildUsageGroups,
  formatUsageAge,
  isAnyUsageRefreshing,
  latestFetchedAt,
  type UsageRow,
} from "@renderer/lib/usage-view";
import { orpc } from "@renderer/orpc-client";
import type { UsageProvider } from "@shared/usage-keys";
import { useMutation } from "@tanstack/react-query";
import { BarChart3, LoaderCircle, RefreshCw } from "lucide-react";
import type { ComponentType, ReactNode, SVGProps } from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ClaudeCodeIcon,
  CodexIcon,
  CursorAgentIcon,
} from "./session-type-icons";
import { UsageMetrics } from "./usage-metrics";

const AGE_TICK_MS = 30_000;

const PROVIDER_META: Record<
  UsageProvider,
  {
    title: string;
    icon: ComponentType<SVGProps<SVGSVGElement>>;
    description: string;
  }
> = {
  claude: {
    title: "Claude",
    icon: ClaudeCodeIcon,
    description: "Rate-limit windows for each Claude login.",
  },
  codex: {
    title: "Codex",
    icon: CodexIcon,
    description: "Rate-limit windows reported by the Codex app-server.",
  },
  cursor: {
    title: "Cursor",
    icon: CursorAgentIcon,
    description: "Plan spend and on-demand limits for the Cursor CLI login.",
  },
};

/** Re-renders on a timer so the "updated" stamps stay honest. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}

export function UsagePage() {
  const entries = useAppState((state) => state.usage.entries);
  const claudeAccounts = useAppState((state) => state.claudeAccounts.accounts);
  const codexAccounts = useAppState((state) => state.codexAccounts.accounts);
  const now = useNow(AGE_TICK_MS);

  const groups = buildUsageGroups({ entries, claudeAccounts, codexAccounts });
  const trackedCount = groups.reduce((total, g) => total + g.rows.length, 0);
  const lastUpdated = formatUsageAge(latestFetchedAt(entries), now);
  const anyRefreshing = isAnyUsageRefreshing(entries);

  const refreshAll = useMutation(
    orpc.usage.refreshAll.mutationOptions({
      onError: (error) =>
        toast.error(error.message || "Failed to refresh usage"),
    }),
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border/70 px-2 py-1.5">
        <MobileSidebarTrigger className="md:hidden" />
        <BarChart3 className="size-3.5 text-muted-foreground max-md:hidden" />
        <span className="text-sm font-medium">Usage</span>
        <span className="text-xs text-muted-foreground">
          {trackedCount} tracked login{trackedCount === 1 ? "" : "s"}
          {lastUpdated ? ` · updated ${lastUpdated}` : ""}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={refreshAll.isPending || anyRefreshing}
          onClick={() => refreshAll.mutate(undefined)}
        >
          <RefreshCw
            className={
              refreshAll.isPending || anyRefreshing
                ? "mr-1.5 size-3.5 animate-spin"
                : "mr-1.5 size-3.5"
            }
          />
          Refresh all
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4">
          {groups.map((group) => {
            const meta = PROVIDER_META[group.provider];
            return (
              <section key={group.provider} className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <meta.icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="text-sm font-medium">{meta.title}</span>
                </div>
                <p className="text-muted-foreground text-sm">
                  {meta.description}
                </p>
                <div className="flex flex-col gap-2">
                  {group.rows.map((row) => (
                    <UsageCard key={row.key} row={row} now={now} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function UsageCard({ row, now }: { row: UsageRow; now: number }) {
  const entry = row.entry;
  const refresh = useMutation(
    orpc.usage.refresh.mutationOptions({
      onSuccess: (result) => {
        if (!result.ok && result.message) {
          toast.error(result.message);
        }
      },
      onError: (error) =>
        toast.error(error.message || "Failed to refresh usage"),
    }),
  );

  const refreshing = entry?.refreshing || refresh.isPending;
  const age = formatUsageAge(entry?.fetchedAt ?? null, now);
  const canRefresh = entry != null && entry.status !== "unsupported";

  return (
    <div className="rounded-md border border-border/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium">{row.label}</span>
            {row.badges.map((badge) => (
              <Badge key={badge} variant="secondary">
                {badge}
              </Badge>
            ))}
            {row.needsRelogin ? (
              <Badge variant="destructive">Needs re-login</Badge>
            ) : null}
          </div>
          <div className="text-muted-foreground mt-0.5 text-xs">
            {age ? `Updated ${age}` : "No reading yet"}
          </div>
        </div>
        {canRefresh ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            title="Refresh usage"
            disabled={refreshing}
            onClick={() => refresh.mutate({ key: row.key })}
          >
            {refreshing ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </Button>
        ) : null}
      </div>

      <UsageCardBody row={row} refreshing={refreshing} />
    </div>
  );
}

function UsageCardBody({
  row,
  refreshing,
}: {
  row: UsageRow;
  refreshing: boolean;
}) {
  const entry = row.entry;

  if (!entry) {
    return <CardNote>Not tracked yet.</CardNote>;
  }

  if (entry.status === "unsupported") {
    return <CardNote>{entry.error ?? "Usage is not available."}</CardNote>;
  }

  if (!entry.data) {
    if (refreshing || entry.status === "pending") {
      return (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" />
          Reading usage...
        </div>
      );
    }
    return (
      <CardNote tone="error">{entry.error ?? "Usage is unavailable."}</CardNote>
    );
  }

  return (
    <div className="mt-2 space-y-1.5">
      <UsageMetrics entry={entry} />
      {entry.status === "error" && entry.error ? (
        <p className="text-[10px] text-[#DE7356]">
          Last refresh failed: {entry.error}
        </p>
      ) : null}
    </div>
  );
}

function CardNote({ tone, children }: { tone?: "error"; children: ReactNode }) {
  return (
    <p
      className={
        tone === "error"
          ? "mt-2 text-xs text-[#DE7356]"
          : "mt-2 text-xs text-muted-foreground"
      }
    >
      {children}
    </p>
  );
}
