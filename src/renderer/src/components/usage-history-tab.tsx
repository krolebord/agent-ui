import {
  enumerateDays,
  formatCount,
  formatDayShort,
  formatPercent,
  formatTokens,
  formatUsd,
} from "@renderer/lib/usage-history-format";
import {
  bucketValue,
  deriveUsageHistoryView,
  sortModelsForMetric,
  type UsageCostBasis,
} from "@renderer/lib/usage-history-view";
import { cn } from "@renderer/lib/utils";
import {
  USAGE_HISTORY_PROVIDERS,
  type UsageHistoryProvider,
  type UsageHistorySummary,
} from "@shared/usage-history";
import { useMemo, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { UsageHistoryChart } from "./usage-history-chart";
import { USAGE_PROVIDER_PRESENTATION } from "./usage-history-providers";

type Breakdown = "model" | "day";

const COST_BASIS_LABEL: Record<UsageCostBasis, string> = {
  none: "no cost recorded",
  estimated: "API estimate",
  billed: "billed by provider",
  mixed: "estimate + billed",
};

interface UsageHistoryTabProps {
  metric: "cost" | "tokens";
  summary: UsageHistorySummary | undefined;
  isLoading: boolean;
}

export function UsageHistoryTab({
  metric,
  summary,
  isLoading,
}: UsageHistoryTabProps) {
  const [breakdown, setBreakdown] = useState<Breakdown>("model");
  const view = useMemo(() => deriveUsageHistoryView(summary), [summary]);
  const days = useMemo(
    () =>
      summary
        ? enumerateDays(summary.sinceDay, summary.untilDay)
        : ([] as string[]),
    [summary],
  );
  const models = useMemo(
    () => sortModelsForMetric(view.models, metric),
    [metric, view.models],
  );
  const daysNewestFirst = useMemo(
    () => [...view.daily].reverse(),
    [view.daily],
  );

  if (isLoading && !summary) {
    return <UsageHistorySkeleton />;
  }

  const format = metric === "cost" ? formatUsd : formatTokens;
  const activeProviders = view.activeProviders;

  return (
    <div className="flex flex-col gap-8">
      <UsageHistoryNotices summary={summary} />

      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-col gap-1">
            <span className="text-4xl font-semibold tabular-nums">
              {metric === "cost"
                ? formatUsd(view.costUsd)
                : formatTokens(view.totalTokens)}
            </span>
            <span className="text-xs text-muted-foreground">
              {metric === "cost"
                ? `${formatCount(view.sessions)} sessions · ${COST_BASIS_LABEL[view.costBasis]}`
                : `${formatCount(view.sessions)} sessions`}
            </span>
          </div>

          {activeProviders.map((provider) => {
            const totals = view.providers.find(
              (entry) => entry.provider === provider,
            );
            const presentation = USAGE_PROVIDER_PRESENTATION[provider];
            const Mark = presentation.mark;
            const sessions = totals?.sessions ?? 0;
            const share =
              metric === "cost"
                ? (totals?.costShare ?? 0)
                : (totals?.tokenShare ?? 0);
            return (
              <div key={provider} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="flex min-w-0 items-center gap-2 text-sm">
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: presentation.color }}
                    />
                    <Mark className="size-4 shrink-0" aria-hidden />
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <span className="truncate">{presentation.label}</span>
                      <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground tabular-nums">
                        {formatCount(sessions)}{" "}
                        {sessions === 1 ? "session" : "sessions"}
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-medium tabular-nums">
                    {metric === "cost"
                      ? formatUsd(totals?.costUsd ?? 0)
                      : formatTokens(totals?.totalTokens ?? 0)}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {metric === "cost"
                    ? `${formatPercent(share)} of cost · ${formatTokens(totals?.totalTokens ?? 0)} tokens`
                    : `${formatPercent(share)} of tokens · ${formatUsd(totals?.costUsd ?? 0)}`}
                </span>
              </div>
            );
          })}
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <h2 className="text-sm font-medium">
            Daily {metric === "cost" ? "cost" : "processed tokens"}
          </h2>
          <UsageHistoryChart
            providers={activeProviders}
            days={days}
            daily={view.daily}
            metric={metric}
          />
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Totals</h2>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
          <Metric
            label="Processed tokens"
            value={formatTokens(view.totalTokens)}
          />
          <Metric
            label="Cached input"
            value={formatTokens(view.cachedInputTokens)}
          />
          <Metric
            label="Uncached input"
            value={formatTokens(view.uncachedInputTokens)}
          />
          <Metric label="Output" value={formatTokens(view.outputTokens)} />
          <Metric
            label="Cache savings"
            value={formatUsd(view.cacheSavingsUsd)}
          />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Breakdown</h2>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-label="Usage breakdown"
            value={breakdown}
            onValueChange={(value) => {
              if (value === "model" || value === "day") {
                setBreakdown(value);
              }
            }}
          >
            <ToggleGroupItem value="model">Model</ToggleGroupItem>
            <ToggleGroupItem value="day">Day</ToggleGroupItem>
          </ToggleGroup>
        </div>

        {breakdown === "model" ? (
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col className="w-2/5" />
              <col className="w-1/5" />
              <col className="w-1/5" />
              <col className="w-1/5" />
            </colgroup>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 font-normal">Model</th>
                <th className="py-2 text-right font-normal">Cost</th>
                <th className="py-2 text-right font-normal">Share</th>
                <th className="py-2 text-right font-normal">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {models.length === 0 ? (
                <EmptyBreakdownRow columns={4} />
              ) : (
                models.map((model) => {
                  const Mark = USAGE_PROVIDER_PRESENTATION[model.provider].mark;
                  return (
                    <tr
                      key={`${model.provider}:${model.model}`}
                      className="border-b border-border/50 transition-colors hover:bg-muted/50"
                    >
                      <td className="py-2">
                        <span className="flex items-center gap-2">
                          <Mark className="size-3.5 shrink-0" aria-hidden />
                          <span className="truncate">{model.model}</span>
                        </span>
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatUsd(model.costUsd)}
                      </td>
                      <td className="py-2 text-right text-muted-foreground tabular-nums">
                        {formatPercent(
                          metric === "cost"
                            ? model.costShare
                            : model.tokenShare,
                        )}
                      </td>
                      <td className="py-2 text-right text-muted-foreground tabular-nums">
                        {formatTokens(model.totalTokens)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        ) : (
          <DayBreakdownTable
            activeProviders={activeProviders}
            days={daysNewestFirst}
            format={format}
            metric={metric}
          />
        )}
      </section>
    </div>
  );
}

function DayBreakdownTable({
  activeProviders,
  days,
  format,
  metric,
}: {
  activeProviders: UsageHistoryProvider[];
  days: ReturnType<typeof deriveUsageHistoryView>["daily"];
  format: (value: number) => string;
  metric: "cost" | "tokens";
}) {
  const valueColumnWidth = `${60 / (activeProviders.length + 2)}%`;

  return (
    <table className="w-full table-fixed text-sm">
      <colgroup>
        <col className="w-2/5" />
        {activeProviders.map((provider) => (
          <col key={provider} style={{ width: valueColumnWidth }} />
        ))}
        <col style={{ width: valueColumnWidth }} />
        <col style={{ width: valueColumnWidth }} />
      </colgroup>
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted-foreground">
          <th className="py-2 font-normal">Day</th>
          {activeProviders.map((provider) => (
            <th key={provider} className="py-2 text-right font-normal">
              {USAGE_PROVIDER_PRESENTATION[provider].label}
            </th>
          ))}
          <th className="py-2 text-right font-normal">Total</th>
          <th className="py-2 text-right font-normal">Tokens</th>
        </tr>
      </thead>
      <tbody>
        {days.length === 0 ? (
          <EmptyBreakdownRow columns={activeProviders.length + 3} />
        ) : (
          days.map((day) => (
            <tr
              key={day.day}
              className="border-b border-border/50 transition-colors hover:bg-muted/50"
            >
              <td className="py-2">{formatDayShort(day.day)}</td>
              {activeProviders.map((provider) => (
                <td
                  key={provider}
                  className="py-2 text-right text-muted-foreground tabular-nums"
                >
                  {format(bucketValue(day.byProvider.get(provider), metric))}
                </td>
              ))}
              <td className="py-2 text-right tabular-nums">
                {format(bucketValue(day, metric))}
              </td>
              <td className="py-2 text-right text-muted-foreground tabular-nums">
                {formatTokens(day.totalTokens)}
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

function EmptyBreakdownRow({ columns }: { columns: number }) {
  return (
    <tr>
      <td colSpan={columns} className="py-6 text-center text-muted-foreground">
        No activity in this window.
      </td>
    </tr>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-base font-medium tabular-nums">{value}</span>
    </div>
  );
}

function UsageHistoryNotices({
  summary,
}: {
  summary: UsageHistorySummary | undefined;
}) {
  if (!summary) {
    return null;
  }
  const notices: string[] = [];
  if (summary.pricing.status === "unavailable") {
    notices.push(
      "Model prices are unavailable, so every model reports as unpriced.",
    );
  }
  for (const source of summary.sources) {
    if (source.status !== "failed") {
      continue;
    }
    const label = USAGE_PROVIDER_PRESENTATION[source.provider].label;
    notices.push(
      source.kind === "api"
        ? `${label} usage could not be fetched, so its numbers may be incomplete.`
        : `${label} transcripts at ${source.origin} could not be read.`,
    );
  }
  if (notices.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
      {notices.map((notice) => (
        <span key={notice}>{notice}</span>
      ))}
    </div>
  );
}

function Bar({ className }: { className: string }) {
  return <div className={cn("animate-pulse rounded bg-muted", className)} />;
}

function UsageHistorySkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <Bar className="h-10 w-36" />
            <Bar className="h-4 w-32" />
          </div>
          {USAGE_HISTORY_PROVIDERS.map((provider) => (
            <div key={provider} className="flex flex-col gap-1">
              <div className="flex min-h-5 items-center justify-between gap-4">
                <span className="flex items-center gap-2">
                  <Bar className="size-2 shrink-0 rounded-full" />
                  <Bar className="size-4 shrink-0 rounded-full" />
                  <Bar className="h-3.5 w-20" />
                </span>
                <Bar className="h-3.5 w-14" />
              </div>
              <Bar className="h-4 w-36" />
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-3">
          <Bar className="h-5 w-24" />
          <Bar className="ml-16 h-56" />
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Totals</h2>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
          {[
            "Processed tokens",
            "Cached input",
            "Uncached input",
            "Output",
            "Cache savings",
          ].map((label) => (
            <div key={label} className="flex flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">{label}</span>
              <Bar className="h-6 w-16" />
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Breakdown</h2>
          <Bar className="h-7 w-28" />
        </div>
        <Bar className="h-44" />
      </section>
    </div>
  );
}
