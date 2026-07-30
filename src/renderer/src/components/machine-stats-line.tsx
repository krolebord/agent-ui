import { useAppState } from "./sync-state-provider";

export function MachineStatsLine() {
  const enabled = useAppState(
    (state) => state.appSettings.machineStats.enabled,
  );
  const stats = useAppState((state) => state.machineStats);

  if (!enabled) {
    return null;
  }

  const cpuLabel =
    stats.cpuLoadPercent === null
      ? "--"
      : `${Math.round(stats.cpuLoadPercent)}%`;
  const temperatureLabel =
    stats.cpuTemperatureCelsius === null
      ? ""
      : ` (${Math.round(stats.cpuTemperatureCelsius)}C)`;
  const memoryLabel =
    stats.memoryUsedBytes === null || stats.memoryTotalBytes === null
      ? "-- / -- GB"
      : `${formatMemoryGiB(stats.memoryUsedBytes)} / ${formatMemoryGiB(
          stats.memoryTotalBytes,
        )} GB`;

  return (
    <div
      className="flex h-7 shrink-0 items-center border-t border-border/60 px-2 font-mono text-[10px] text-zinc-500"
      title={stats.error ?? undefined}
    >
      <span className="truncate">
        CPU: {cpuLabel}
        {temperatureLabel} | {memoryLabel}
      </span>
    </div>
  );
}

function formatMemoryGiB(bytes: number): string {
  const value = bytes / 1024 ** 3;
  return value >= 10 ? value.toFixed(1) : value.toFixed(2);
}
