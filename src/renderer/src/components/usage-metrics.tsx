import type { UsageEntry } from "@renderer/hooks/use-account-usage";
import { formatPlanType } from "@renderer/lib/plan-label";
import {
  computeUsagePace,
  computeUsagePaceBetween,
  formatUsagePaceDelta,
  parseEpochMillis,
  type UsagePace,
} from "@renderer/lib/usage-pace";
import { cn } from "@renderer/lib/utils";

type ProviderData<TProvider extends UsageEntry["provider"]> = NonNullable<
  Extract<UsageEntry, { provider: TProvider }>["data"]
>;

export type ClaudeUsageData = ProviderData<"claude">;
export type CodexUsageData = ProviderData<"codex">;
export type CursorUsageData = ProviderData<"cursor">;

type ClaudeBucketKey = "five_hour" | "seven_day" | "seven_day_sonnet";

const CLAUDE_BUCKETS: { key: ClaudeBucketKey; label: string }[] = [
  { key: "five_hour", label: "5 hour" },
  { key: "seven_day", label: "Weekly" },
  { key: "seven_day_sonnet", label: "Sonnet" },
];

const CLAUDE_WINDOW_SECONDS: Record<ClaudeBucketKey, number> = {
  five_hour: 5 * 60 * 60,
  seven_day: 7 * 24 * 60 * 60,
  seven_day_sonnet: 7 * 24 * 60 * 60,
};

function getBarColor(pct: number): string {
  return pct >= 100 ? "bg-[#DE7356]" : "bg-zinc-500";
}

function getTextColor(pct: number): string {
  return pct >= 100 ? "text-[#DE7356]" : "text-zinc-400";
}

export function formatResetsAt(resetsAt: string | null): string | null {
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

export function formatCodexWindowLabel(windowSeconds: number): string {
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

export function MetricBar({
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

function CreditsRow({ value }: { value: string }) {
  return (
    <div className="flex items-center justify-between text-[10px]">
      <span className="text-zinc-400">Credits</span>
      <span className="tabular-nums text-zinc-400">{value}</span>
    </div>
  );
}

export function ClaudeUsageMetrics({ usage }: { usage: ClaudeUsageData }) {
  return (
    <>
      {CLAUDE_BUCKETS.map(({ key, label }) => {
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
              <MetricBar
                label="Extra usage"
                valueLabel={`$${used.toFixed(2)} / $${limit.toFixed(2)}`}
                pct={pct}
              />
            );
          })()
        : null}
    </>
  );
}

export function CodexUsageMetrics({ usage }: { usage: CodexUsageData }) {
  const planType = usage.planType?.trim();
  const windows = [usage.primaryWindow, usage.secondaryWindow]
    .filter((window): window is NonNullable<typeof window> => window != null)
    .sort((a, b) => a.windowSeconds - b.windowSeconds);

  return (
    <>
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
        <CreditsRow
          value={
            usage.credits.unlimited
              ? "Unlimited"
              : `$${usage.credits.balance.toFixed(2)}`
          }
        />
      ) : null}
    </>
  );
}

export function CursorUsageMetrics({ usage }: { usage: CursorUsageData }) {
  const plan = usage.planUsage;
  const planLabel = formatPlanType(usage.membershipType) ?? "Plan";
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
  const paceForCycle = (usedPercent: number) =>
    cycleStartMs != null && cycleEndMs != null
      ? computeUsagePaceBetween({
          usedPercent,
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
    <>
      <MetricBar
        label={planLabel}
        subLabel={cycleEndLabel ? `resets ${cycleEndLabel}` : null}
        valueLabel={`${Math.round(plan.totalPercentUsed)}%`}
        pct={Math.round(plan.totalPercentUsed)}
        pace={paceForCycle(plan.totalPercentUsed)}
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
        const percentUsed = (entry.used / entry.limit) * 100;
        return (
          <MetricBar
            key={entry.key}
            label={entry.label}
            valueLabel={`$${used.toFixed(2)} / $${cap.toFixed(2)}`}
            pct={Math.round(percentUsed)}
            pace={paceForCycle(percentUsed)}
          />
        );
      })}
      {usage.credits ? (
        <CreditsRow value={`$${usage.credits.balance.toFixed(2)}`} />
      ) : null}
    </>
  );
}

export function UsageMetrics({ entry }: { entry: UsageEntry }) {
  switch (entry.provider) {
    case "claude":
      return entry.data ? <ClaudeUsageMetrics usage={entry.data} /> : null;
    case "codex":
      return entry.data ? <CodexUsageMetrics usage={entry.data} /> : null;
    case "cursor":
      return entry.data ? <CursorUsageMetrics usage={entry.data} /> : null;
  }
}
