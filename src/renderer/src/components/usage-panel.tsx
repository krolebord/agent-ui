import { useActiveSessionId } from "@renderer/hooks/use-active-session-id";
import { cn } from "@renderer/lib/utils";
import { orpc } from "@renderer/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { useAppState } from "./sync-state-provider";

type UsageBucketKey = "five_hour" | "seven_day" | "seven_day_sonnet";

const BUCKET_LABELS: { key: UsageBucketKey; label: string }[] = [
  { key: "five_hour", label: "5 hour" },
  { key: "seven_day", label: "Weekly" },
  { key: "seven_day_sonnet", label: "Sonnet" },
];

type UsageSource = "claude" | "codex" | "cursorAgent";

type ClaudeUsageData = {
  five_hour: { utilization: number; resets_at: string | null } | null;
  seven_day: { utilization: number; resets_at: string | null } | null;
  seven_day_sonnet: { utilization: number; resets_at: string | null } | null;
  extra_usage: {
    is_enabled: boolean;
    monthly_limit: number | null;
    used_credits: number | null;
    utilization: number | null;
  } | null;
};

type CodexUsageData = {
  planType?: string | null;
  primaryWindow: {
    utilization: number;
    resetsAt: string | null;
    windowSeconds: number;
  } | null;
  secondaryWindow: {
    utilization: number;
    resetsAt: string | null;
    windowSeconds: number;
  } | null;
  credits?: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: number;
  };
};

function getBarColor(pct: number): string {
  return pct >= 100 ? "bg-[#DE7356]" : "bg-zinc-500";
}

function getTextColor(pct: number): string {
  return pct >= 100 ? "text-[#DE7356]" : "text-zinc-400";
}

function formatResetsAt(resetsAt: string | null): string | null {
  if (!resetsAt) {
    return null;
  }

  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatMembership(type: string | null | undefined): string | null {
  if (!type) {
    return null;
  }
  return type
    .split(/[_-]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function MetricBar({
  label,
  subLabel,
  valueLabel,
  pct,
}: {
  label: string;
  subLabel?: string | null;
  valueLabel: string;
  pct: number;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-zinc-400">
          {label}
          {subLabel ? (
            <span className="text-zinc-500">{` (${subLabel})`}</span>
          ) : null}
        </span>
        <span className={cn("tabular-nums", getTextColor(pct))}>
          {valueLabel}
        </span>
      </div>
      <div className="h-1 rounded-full bg-white/10">
        <div
          className={cn("h-full rounded-full transition-all", getBarColor(pct))}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  );
}

export function UsagePanel() {
  const activeSessionId = useActiveSessionId();
  const activeSession = useAppState((x) =>
    activeSessionId ? (x.sessions[activeSessionId] ?? null) : null,
  );

  const usageSource: UsageSource | null =
    activeSession?.type === "claude-local-terminal"
      ? "claude"
      : activeSession?.type === "codex-local-terminal"
        ? "codex"
        : activeSession?.type === "cursor-agent"
          ? "cursorAgent"
          : null;

  const claudeQuery = useQuery(
    orpc.sessions.localClaude.getUsage.queryOptions({
      retry: false,
      refetchInterval: 5 * 60_000,
      staleTime: 5 * 60_000,
      enabled: usageSource === "claude",
    }),
  );

  const codexQuery = useQuery(
    orpc.sessions.codex.getUsage.queryOptions({
      retry: false,
      refetchInterval: 5 * 60_000,
      staleTime: 5 * 60_000,
      enabled: usageSource === "codex",
    }),
  );

  const cursorAgentQuery = useQuery(
    orpc.sessions.cursorAgent.getUsage.queryOptions({
      retry: false,
      refetchInterval: 5 * 60_000,
      staleTime: 5 * 60_000,
      enabled: usageSource === "cursorAgent",
    }),
  );

  if (!usageSource) {
    return (
      <div className="border-t border-border/70 p-2">
        <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-center text-xs text-zinc-500">
          Usage is available for Claude, Codex, and Cursor sessions.
        </div>
      </div>
    );
  }

  if (usageSource === "cursorAgent") {
    const handleRefetch = async () => {
      const result = await cursorAgentQuery.refetch();
      if (result.error) {
        toast.error(result.error.message);
      }
    };

    if (cursorAgentQuery.data?.ok && cursorAgentQuery.data.usage) {
      const usage = cursorAgentQuery.data.usage;
      const plan = usage.planUsage;
      const spent = plan.includedSpend / 100;
      const limit = plan.limit != null ? plan.limit / 100 : null;
      const planPct = Math.round(plan.totalPercentUsed);
      const planValueLabel =
        limit != null
          ? `$${spent.toFixed(2)} / $${limit.toFixed(2)}`
          : `${planPct}%`;
      const planLabel = formatMembership(usage.membershipType) ?? "Plan";

      const slData = usage.spendLimitUsage;
      const cycleEnd = new Date(Number(usage.billingCycleEnd));
      const cycleEndLabel = Number.isNaN(cycleEnd.getTime())
        ? null
        : new Intl.DateTimeFormat(undefined, {
            month: "short",
            day: "numeric",
          }).format(cycleEnd);

      const onDemand: {
        key: string;
        label: string;
        used: number;
        limit: number;
      }[] = [];
      if (
        slData?.individualUsed != null &&
        slData.individualLimit != null &&
        slData.individualLimit > 0
      ) {
        onDemand.push({
          key: "individual",
          label: "On-demand",
          used: slData.individualUsed,
          limit: slData.individualLimit,
        });
      }
      if (
        slData?.pooledUsed != null &&
        slData.pooledLimit != null &&
        slData.pooledLimit > 0
      ) {
        onDemand.push({
          key: "pooled",
          label: "On-demand (team)",
          used: slData.pooledUsed,
          limit: slData.pooledLimit,
        });
      }

      return (
        <div className="border-t border-border/70 p-2">
          <div className="space-y-1.5">
            <MetricBar
              label={planLabel}
              subLabel={cycleEndLabel ? `resets ${cycleEndLabel}` : null}
              valueLabel={planValueLabel}
              pct={planPct}
            />
            {plan.autoPercentUsed != null ? (
              <MetricBar
                label="Auto"
                valueLabel={`${Math.round(plan.autoPercentUsed)}%`}
                pct={Math.round(plan.autoPercentUsed)}
              />
            ) : null}
            {plan.apiPercentUsed != null ? (
              <MetricBar
                label="API"
                valueLabel={`${Math.round(plan.apiPercentUsed)}%`}
                pct={Math.round(plan.apiPercentUsed)}
              />
            ) : null}
            {onDemand.map((entry) => {
              const used = entry.used / 100;
              const cap = entry.limit / 100;
              const pct = Math.round((entry.used / entry.limit) * 100);
              return (
                <MetricBar
                  key={entry.key}
                  label={entry.label}
                  valueLabel={`$${used.toFixed(2)} / $${cap.toFixed(2)}`}
                  pct={pct}
                />
              );
            })}
            {usage.credits ? (
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-zinc-400">Credits</span>
                <span className="tabular-nums text-zinc-400">
                  ${usage.credits.balance.toFixed(2)}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      );
    }

    if (cursorAgentQuery.isPending) {
      return null;
    }

    if (cursorAgentQuery.isFetching) {
      return (
        <div className="border-t border-border/70 p-2">
          <div className="flex items-center justify-center gap-1.5 py-1.5 text-xs text-zinc-400">
            <LoaderCircle className="size-3.5 animate-spin" />
            Loading usage...
          </div>
        </div>
      );
    }

    return (
      <div className="border-t border-border/70 p-2">
        <button
          type="button"
          onClick={() => void handleRefetch()}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-zinc-100 transition hover:bg-white/10"
        >
          <BarChart3 className="size-3.5" />
          Show Usage
        </button>
      </div>
    );
  }

  if (usageSource === "codex") {
    const handleRefetch = async () => {
      const result = await codexQuery.refetch();
      if (result.error) {
        toast.error(result.error.message);
      }
    };

    if (codexQuery.data?.ok && codexQuery.data.usage) {
      const usage = codexQuery.data.usage as CodexUsageData;
      const planType = usage.planType?.trim();
      const primaryPct = usage.primaryWindow
        ? Math.round(usage.primaryWindow.utilization)
        : null;
      const secondaryPct = usage.secondaryWindow
        ? Math.round(usage.secondaryWindow.utilization)
        : null;
      const primaryResetsAt = usage.primaryWindow
        ? formatResetsAt(usage.primaryWindow.resetsAt)
        : null;
      const secondaryResetsAt = usage.secondaryWindow
        ? formatResetsAt(usage.secondaryWindow.resetsAt)
        : null;
      return (
        <div className="border-t border-border/70 p-2">
          <div className="space-y-1.5">
            {planType ? (
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-zinc-400">Plan</span>
                <span className="tabular-nums text-zinc-300">{planType}</span>
              </div>
            ) : null}
            {primaryPct !== null ? (
              <div className="space-y-0.5">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-zinc-400">
                    5 hour
                    {primaryResetsAt ? (
                      <span className="text-zinc-500">{` (${primaryResetsAt})`}</span>
                    ) : null}
                  </span>
                  <span
                    className={cn("tabular-nums", getTextColor(primaryPct))}
                  >
                    {primaryPct}%
                  </span>
                </div>
                <div className="h-1 rounded-full bg-white/10">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all",
                      getBarColor(primaryPct),
                    )}
                    style={{ width: `${Math.min(primaryPct, 100)}%` }}
                  />
                </div>
              </div>
            ) : null}
            {secondaryPct !== null ? (
              <div className="space-y-0.5">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-zinc-400">
                    Weekly
                    {secondaryResetsAt ? (
                      <span className="text-zinc-500">{` (${secondaryResetsAt})`}</span>
                    ) : null}
                  </span>
                  <span
                    className={cn("tabular-nums", getTextColor(secondaryPct))}
                  >
                    {secondaryPct}%
                  </span>
                </div>
                <div className="h-1 rounded-full bg-white/10">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all",
                      getBarColor(secondaryPct),
                    )}
                    style={{ width: `${Math.min(secondaryPct, 100)}%` }}
                  />
                </div>
              </div>
            ) : null}
            {usage.credits?.hasCredits ? (
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-zinc-400">Credits</span>
                <span className="tabular-nums text-zinc-400">
                  {usage.credits.unlimited
                    ? "Unlimited"
                    : `$${usage.credits.balance.toFixed(2)}`}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      );
    }

    if (codexQuery.isPending) {
      return null;
    }

    if (codexQuery.isFetching) {
      return (
        <div className="border-t border-border/70 p-2">
          <div className="flex items-center justify-center gap-1.5 py-1.5 text-xs text-zinc-400">
            <LoaderCircle className="size-3.5 animate-spin" />
            Loading usage...
          </div>
        </div>
      );
    }

    return (
      <div className="border-t border-border/70 p-2">
        <button
          type="button"
          onClick={() => void handleRefetch()}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-zinc-100 transition hover:bg-white/10"
        >
          <BarChart3 className="size-3.5" />
          Show Usage
        </button>
      </div>
    );
  }

  const activeClaudeQuery = claudeQuery;

  const handleRefetch = async () => {
    const result = await activeClaudeQuery.refetch();
    if (result.error) {
      toast.error(result.error.message);
    }
  };

  if (activeClaudeQuery.data?.ok && activeClaudeQuery.data.usage) {
    const usage = activeClaudeQuery.data.usage as ClaudeUsageData;
    return (
      <div className="border-t border-border/70 p-2">
        <div className="space-y-1.5">
          {BUCKET_LABELS.map(({ key, label }) => {
            const bucket = usage[key];
            if (!bucket) return null;
            const pct = Math.round(bucket.utilization);
            const resetsAt = formatResetsAt(bucket.resets_at);
            return (
              <div key={key} className="space-y-0.5">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-zinc-400">
                    {label}
                    {resetsAt ? (
                      <span className="text-zinc-500">{` (${resetsAt})`}</span>
                    ) : null}
                  </span>
                  <span className={cn("tabular-nums", getTextColor(pct))}>
                    {pct}%
                  </span>
                </div>
                <div className="h-1 rounded-full bg-white/10">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all",
                      getBarColor(pct),
                    )}
                    style={{ width: `${Math.min(pct, 100)}%` }}
                  />
                </div>
              </div>
            );
          })}
          {usage.extra_usage?.is_enabled
            ? (() => {
                const used = (usage.extra_usage.used_credits ?? 0) / 100;
                const limit = (usage.extra_usage.monthly_limit ?? 0) / 100;
                const pct = Math.round(usage.extra_usage.utilization ?? 0);
                return (
                  <div className="space-y-0.5">
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-zinc-400">Extra usage</span>
                      <span className={cn("tabular-nums", getTextColor(pct))}>
                        ${used.toFixed(2)} / ${limit.toFixed(2)}
                      </span>
                    </div>
                    <div className="h-1 rounded-full bg-white/10">
                      <div
                        className={cn(
                          "h-full rounded-full transition-all",
                          getBarColor(pct),
                        )}
                        style={{ width: `${Math.min(pct, 100)}%` }}
                      />
                    </div>
                  </div>
                );
              })()
            : null}
        </div>
      </div>
    );
  }

  if (activeClaudeQuery.isPending) {
    return null;
  }

  if (activeClaudeQuery.isFetching) {
    return (
      <div className="border-t border-border/70 p-2">
        <div className="flex items-center justify-center gap-1.5 py-1.5 text-xs text-zinc-400">
          <LoaderCircle className="size-3.5 animate-spin" />
          Loading usage...
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-border/70 p-2">
      <button
        type="button"
        onClick={() => void handleRefetch()}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-zinc-100 transition hover:bg-white/10"
      >
        <BarChart3 className="size-3.5" />
        Show Usage
      </button>
    </div>
  );
}
