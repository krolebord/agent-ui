import { cn } from "@renderer/lib/utils";
import { claudeIpc } from "@renderer/lib/ipc";
import type { ClaudeUsageData, ClaudeUsageBucket } from "@shared/claude-types";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, LoaderCircle } from "lucide-react";
import { toast } from "sonner";

type UsageBucketKey = "five_hour" | "seven_day" | "seven_day_sonnet";

const BUCKET_LABELS: { key: UsageBucketKey; label: string }[] = [
  { key: "five_hour", label: "5 hour" },
  { key: "seven_day", label: "Weekly" },
  { key: "seven_day_sonnet", label: "Sonnet" },
];

function getBarColor(pct: number): string {
  return pct >= 100 ? "bg-[#DE7356]" : "bg-zinc-500";
}

function getTextColor(pct: number): string {
  return pct >= 100 ? "text-[#DE7356]" : "text-zinc-400";
}

function formatResetsAt(
  resetsAt: ClaudeUsageBucket["resets_at"],
): string | null {
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

async function fetchUsage(): Promise<ClaudeUsageData> {
  const result = await claudeIpc.getUsage();
  if (!result.ok) throw new Error(result.message);
  return result.usage;
}

export function UsagePanel() {
  const query = useQuery({
    queryKey: ["usage"],
    queryFn: fetchUsage,
    retry: false,
    refetchInterval: 60_000,
  });

  const handleStart = async () => {
    const result = await query.refetch();
    if (result.error) {
      toast.error(result.error.message);
    }
  };

  if (query.data) {
    const usage = query.data;
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
          {usage.extra_usage && usage.extra_usage.is_enabled
            ? (() => {
                const used = usage.extra_usage.used_credits / 100;
                const limit = usage.extra_usage.monthly_limit / 100;
                const pct = Math.round(usage.extra_usage.utilization);
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

  if (query.isPending) {
    return null;
  }

  if (query.isFetching) {
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
        onClick={() => void handleStart()}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-zinc-100 transition hover:bg-white/10"
      >
        <BarChart3 className="size-3.5" />
        Show Usage
      </button>
    </div>
  );
}
