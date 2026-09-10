import { MobileSidebarTrigger } from "@renderer/components/mobile-sidebar-trigger";
import { Button } from "@renderer/components/ui/button";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@renderer/components/ui/toggle-group";
import {
  isUsageMetric,
  isUsageWindowDays,
  readUsagePagePreferences,
  saveUsagePagePreferences,
  USAGE_WINDOW_DAYS,
  type UsagePagePreferences,
} from "@renderer/lib/usage-history-preferences";
import { makeUsageWindow } from "@renderer/lib/usage-history-view";
import { orpc } from "@renderer/orpc-client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BarChart3, RefreshCw } from "lucide-react";
import { useState } from "react";
import { UsageHistoryTab } from "./usage-history-tab";

const METRIC_OPTIONS = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
] as const;

export function UsagePage() {
  const [preferences, setPreferences] = useState(readUsagePagePreferences);
  const { metric, windowDays } = preferences;

  const [range, setRange] = useState(() =>
    makeUsageWindow(preferences.windowDays),
  );

  const summary = useQuery({
    ...orpc.usageHistory.summary.queryOptions({ input: range }),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const refreshRates = useMutation(
    orpc.usageHistory.refreshRates.mutationOptions(),
  );

  const applyPreferences = (next: UsagePagePreferences) => {
    setPreferences(next);
    saveUsagePagePreferences(next);
  };

  const refreshing = summary.isFetching || refreshRates.isPending;

  const refresh = () => {
    const next = makeUsageWindow(windowDays);
    if (next.sinceDay !== range.sinceDay || next.untilDay !== range.untilDay) {
      setRange(next);
    }
    refreshRates.mutate(undefined, {
      onSettled: () => {
        void summary.refetch();
      },
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-border/70 px-2 py-1.5">
        <MobileSidebarTrigger className="md:hidden" />
        <BarChart3 className="size-3.5 text-muted-foreground max-md:hidden" />
        <span className="text-sm font-medium">Usage</span>

        <div className="ml-auto flex items-center gap-2">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-label="Usage metric"
            value={metric}
            onValueChange={(value) => {
              if (isUsageMetric(value)) {
                applyPreferences({ ...preferences, metric: value });
              }
            }}
          >
            {METRIC_OPTIONS.map((option) => (
              <ToggleGroupItem key={option.value} value={option.value}>
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-label="Usage period"
            value={String(windowDays)}
            onValueChange={(value) => {
              const days = Number(value);
              if (!isUsageWindowDays(days)) {
                return;
              }
              applyPreferences({ ...preferences, windowDays: days });
              setRange(makeUsageWindow(days));
            }}
          >
            {USAGE_WINDOW_DAYS.map((days) => (
              <ToggleGroupItem key={days} value={String(days)}>
                {days} days
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Refresh usage"
            title="Refresh usage"
            disabled={refreshing}
            onClick={refresh}
          >
            <RefreshCw
              className={refreshing ? "size-3.5 animate-spin" : "size-3.5"}
            />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4">
          {summary.error ? (
            <p className="text-sm text-[#DE7356]">
              {summary.error.message || "Usage could not be read."}
            </p>
          ) : (
            <UsageHistoryTab
              metric={metric}
              summary={summary.data}
              isLoading={summary.isPending}
            />
          )}
        </div>
      </div>
    </div>
  );
}
