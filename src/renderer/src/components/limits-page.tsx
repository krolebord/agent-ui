import { MobileSidebarTrigger } from "@renderer/components/mobile-sidebar-trigger";
import { useAppState } from "@renderer/components/sync-state-provider";
import { Button } from "@renderer/components/ui/button";
import {
  buildUsageGroups,
  formatUsageAge,
  isAnyUsageRefreshing,
  latestFetchedAt,
} from "@renderer/lib/usage-view";
import { orpc } from "@renderer/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Gauge, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { UsageLimitsTab } from "./usage-limits-tab";

const AGE_TICK_MS = 30_000;

/** Re-renders on a timer so the "updated" stamps stay honest. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}

/**
 * Plan rate-limit windows per provider login. Kept apart from Usage: this is
 * live quota polled from the providers, while Usage reconstructs historical
 * token spend from transcripts on disk.
 */
export function LimitsPage() {
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
        <Gauge className="size-3.5 text-muted-foreground max-md:hidden" />
        <span className="text-sm font-medium">Limits</span>
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
        <div className="p-4">
          <UsageLimitsTab now={now} />
        </div>
      </div>
    </div>
  );
}
