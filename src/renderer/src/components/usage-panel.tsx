import { useActiveSessionId } from "@renderer/hooks/use-active-session-id";
import {
  computeUsagePace,
  computeUsagePaceBetween,
  formatUsagePaceDelta,
  parseEpochMillis,
  type UsagePace,
} from "@renderer/lib/usage-pace";
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

const CLAUDE_WINDOW_SECONDS: Record<UsageBucketKey, number> = {
  five_hour: 5 * 60 * 60,
  seven_day: 7 * 24 * 60 * 60,
  seven_day_sonnet: 7 * 24 * 60 * 60,
};

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

function formatCodexWindowLabel(windowSeconds: number): string {
  const minutes = windowSeconds / 60;
  if (Math.abs(minutes - 10_080) <= 60) {
    return "Weekly";
  }
  if (Math.abs(minutes - 300) <= 15) {
    return "5 hour";
  }
  if (Math.abs(minutes - 60) <= 5) {
    return "Hourly";
  }

  const hours = minutes / 60;
  if (hours >= 36) {
    return `${Math.round(hours / 24)} day`;
  }
  if (hours >= 1.5) {
    return `${Math.round(hours)} hour`;
  }
  return `${Math.round(minutes)} min`;
}

function MetricBar({
  label,
  subLabel,
  valueLabel,
  pct,
  pace,
}: {
  label: string;
  subLabel?: string | null;
  valueLabel: string;
  pct: number;
  pace?: UsagePace | null;
}) {
  const roundedDelta = pace ? Math.round(pace.deltaPercent) : null;
  const paceDeltaLabel =
    roundedDelta != null && roundedDelta !== 0
      ? formatUsagePaceDelta(roundedDelta)
      : null;
  const paceIsDeficit = (roundedDelta ?? 0) < 0;

  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-zinc-400">
          {label}
          {subLabel ? (
            <span className="text-zinc-500">{` (${subLabel})`}</span>
          ) : null}
        </span>
        <span className="flex items-baseline gap-1 tabular-nums">
          <span className={getTextColor(pct)}>{valueLabel}</span>
          {paceDeltaLabel && roundedDelta != null ? (
            <span
              className={paceIsDeficit ? "text-[#DE7356]" : "text-zinc-500"}
              title={
                paceIsDeficit
                  ? `${Math.abs(roundedDelta)}% deficit vs even pace`
                  : `${roundedDelta}% reserve vs even pace`
              }
            >
              {paceDeltaLabel}
            </span>
          ) : null}
        </span>
      </div>
      <div className="relative h-1 rounded-full bg-white/10">
        <div
          className={cn("h-full rounded-full transition-all", getBarColor(pct))}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
        {pace ? (
          <div
            aria-hidden
            className="pointer-events-none absolute top-1/2 z-10 h-2 w-px -translate-x-1/2 -translate-y-1/2 bg-zinc-300/80"
            style={{
              left: `${Math.min(Math.max(pace.elapsedPercent, 0), 100)}%`,
            }}
          />
        ) : null}
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

  const claudeAccountId =
    activeSession?.type === "claude-local-terminal"
      ? activeSession.startupConfig.accountId
      : undefined;
  const claudeAccount = useAppState((x) =>
    claudeAccountId
      ? (x.claudeAccounts.accounts.find(
          (account) => account.id === claudeAccountId,
        ) ?? null)
      : null,
  );
  const claudeAccountLabel = claudeAccount?.label ?? null;
  const claudeUsageUnsupported = claudeAccount?.type === "setup-token";

  const claudeQuery = useQuery(
    orpc.sessions.localClaude.getUsage.queryOptions({
      input: { accountId: claudeAccountId },
      retry: false,
      refetchInterval: 5 * 60_000,
      staleTime: 5 * 60_000,
      enabled: usageSource === "claude" && !claudeUsageUnsupported,
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
      const planLabel = formatMembership(usage.membershipType) ?? "Plan";

      const slData = usage.spendLimitUsage;
      const cycleStartMs = parseEpochMillis(usage.billingCycleStart);
      const cycleEndMs = parseEpochMillis(usage.billingCycleEnd);
      const cycleEndLabel =
        cycleEndMs == null
          ? null
          : new Intl.DateTimeFormat(undefined, {
              month: "short",
              day: "numeric",
            }).format(new Date(cycleEndMs));
      const monthlyPace =
        cycleStartMs != null && cycleEndMs != null
          ? computeUsagePaceBetween({
              usedPercent: plan.totalPercentUsed,
              startMs: cycleStartMs,
              endMs: cycleEndMs,
            })
          : null;

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
              valueLabel={`${Math.round(plan.totalPercentUsed)}%`}
              pct={Math.round(plan.totalPercentUsed)}
              pace={monthlyPace}
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
                  pace={
                    cycleStartMs != null && cycleEndMs != null
                      ? computeUsagePaceBetween({
                          usedPercent: (entry.used / entry.limit) * 100,
                          startMs: cycleStartMs,
                          endMs: cycleEndMs,
                        })
                      : null
                  }
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
      const windows = [usage.primaryWindow, usage.secondaryWindow]
        .filter(
          (window): window is NonNullable<typeof window> => window != null,
        )
        .sort((a, b) => a.windowSeconds - b.windowSeconds);
      return (
        <div className="border-t border-border/70 p-2">
          <div className="space-y-1.5">
            {planType ? (
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-zinc-400">Plan</span>
                <span className="tabular-nums text-zinc-300">{planType}</span>
              </div>
            ) : null}
            {windows.map((window) => {
              const pct = Math.round(window.utilization);
              return (
                <MetricBar
                  key={`${window.windowSeconds}-${window.resetsAt ?? ""}`}
                  label={formatCodexWindowLabel(window.windowSeconds)}
                  subLabel={formatResetsAt(window.resetsAt)}
                  valueLabel={`${pct}%`}
                  pct={pct}
                  pace={computeUsagePace({
                    usedPercent: window.utilization,
                    windowSeconds: window.windowSeconds,
                    resetsAt: window.resetsAt,
                  })}
                />
              );
            })}
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

  if (claudeUsageUnsupported) {
    return (
      <div className="border-t border-border/70 p-2">
        <div className="space-y-1">
          {claudeAccountLabel ? (
            <div className="text-[10px] text-zinc-500">
              {claudeAccountLabel}
            </div>
          ) : null}
          <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-center text-xs text-zinc-500">
            Usage is not supported for setup-token accounts.
          </div>
        </div>
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
          {claudeAccountLabel ? (
            <div className="text-[10px] text-zinc-500">
              {claudeAccountLabel}
            </div>
          ) : null}
          {BUCKET_LABELS.map(({ key, label }) => {
            const bucket = usage[key];
            if (!bucket) return null;
            const pct = Math.round(bucket.utilization);
            return (
              <MetricBar
                key={key}
                label={label}
                subLabel={formatResetsAt(bucket.resets_at)}
                valueLabel={`${pct}%`}
                pct={pct}
                pace={computeUsagePace({
                  usedPercent: bucket.utilization,
                  windowSeconds: CLAUDE_WINDOW_SECONDS[key],
                  resetsAt: bucket.resets_at,
                })}
              />
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
