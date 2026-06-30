import { orpc } from "@renderer/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Activity, RadioTower } from "lucide-react";

function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function shortenPath(path: string): string {
  return path
    .replace(/^sessions\./, "sessions.")
    .replace(/^projectTerminals\./, "projectTerms.")
    .replace(/^stateSync\./, "state.")
    .replace(/^terminals\./, "term.");
}

export function OrpcTrafficPanel() {
  const trafficQuery = useQuery(
    orpc.diagnostics.getOrpcTrafficSnapshot.queryOptions({
      refetchInterval: 3_000,
      staleTime: 2_000,
      retry: false,
    }),
  );

  const snapshot = trafficQuery.data;
  if (!snapshot?.enabled) {
    return null;
  }

  const topPaths = snapshot.topPaths
    .filter((item) => item.totalBytes > 0)
    .slice(0, 3);

  return (
    <div className="border-t border-border/70 p-2">
      <div className="space-y-2 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-zinc-200">
            <Activity className="size-3.5 shrink-0 text-zinc-400" />
            <span>oRPC</span>
          </div>
          <span className="shrink-0 font-mono text-[10px] text-zinc-300">
            {formatBytes(snapshot.totals.totalBytes)}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <div>
            <div className="font-mono text-[10px] text-zinc-300">
              {formatBytes(snapshot.totals.streamBytes)}
            </div>
            <div className="text-[9px] text-zinc-500">stream</div>
          </div>
          <div>
            <div className="font-mono text-[10px] text-zinc-300">
              {formatCount(snapshot.totals.streamEvents)}
            </div>
            <div className="text-[9px] text-zinc-500">events</div>
          </div>
          <div>
            <div className="font-mono text-[10px] text-zinc-300">
              {formatCount(snapshot.totals.activeStreams)}
            </div>
            <div className="text-[9px] text-zinc-500">active</div>
          </div>
        </div>

        {topPaths.length > 0 ? (
          <div className="space-y-1">
            {topPaths.map((item) => (
              <div key={item.path} className="flex items-center gap-1.5">
                <RadioTower className="size-3 shrink-0 text-zinc-500" />
                <span
                  className="min-w-0 flex-1 truncate text-[10px] text-zinc-400"
                  title={item.path}
                >
                  {shortenPath(item.path)}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-zinc-300">
                  {formatBytes(item.totalBytes)}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
