import { defineServiceState } from "@shared/service-state";
import type { AppSettingsState, MachineStatsSettings } from "./app-settings";
import log from "./logger";

export interface MachineStatsState {
  updatedAt: number | null;
  cpuLoadPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  error: string | null;
}

const machineStatsDefaults: MachineStatsState = {
  updatedAt: null,
  cpuLoadPercent: null,
  memoryUsedBytes: null,
  memoryTotalBytes: null,
  diskUsedBytes: null,
  diskTotalBytes: null,
  error: null,
};

export const defineMachineStatsState = () =>
  defineServiceState({
    key: "machineStats" as const,
    defaults: machineStatsDefaults,
  });

export type MachineStatsServiceState = ReturnType<
  typeof defineMachineStatsState
>;

export class MachineStatsMonitor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private collectInFlight = false;
  private disposed = false;
  private started = false;
  private lastDiskCollectedAt = 0;

  constructor(
    private readonly state: MachineStatsServiceState,
    private readonly appSettingsState: AppSettingsState,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;

    this.appSettingsState.eventTarget.addEventListener(
      "state-update",
      this.handleSettingsUpdate,
    );
    this.syncPolling();
  }

  dispose(): void {
    if (!this.started) return;
    this.started = false;
    this.disposed = true;
    this.appSettingsState.eventTarget.removeEventListener(
      "state-update",
      this.handleSettingsUpdate,
    );
    this.clearTimer();
  }

  private readonly handleSettingsUpdate = () => {
    this.syncPolling();
  };

  private syncPolling(): void {
    if (this.disposed) return;

    this.clearTimer();
    if (!this.appSettingsState.state.machineStats.enabled) {
      this.resetState();
      return;
    }

    void this.collect();
  }

  private scheduleNextCollect(): void {
    if (this.disposed || !this.appSettingsState.state.machineStats.enabled) {
      return;
    }

    const { cpuMemoryPollIntervalSeconds } =
      this.appSettingsState.state.machineStats;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.collect();
    }, cpuMemoryPollIntervalSeconds * 1000);
    this.timer.unref?.();
  }

  private resetState(): void {
    this.lastDiskCollectedAt = 0;
    this.state.updateState((state) => {
      state.updatedAt = null;
      state.cpuLoadPercent = null;
      state.memoryUsedBytes = null;
      state.memoryTotalBytes = null;
      state.diskUsedBytes = null;
      state.diskTotalBytes = null;
      state.error = null;
    });
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private async collect(): Promise<void> {
    if (this.collectInFlight || this.disposed) return;
    this.collectInFlight = true;

    try {
      const settings = this.appSettingsState.state.machineStats;
      if (!settings.enabled) return;

      const [{ currentLoad, mem }, disk] = await Promise.all([
        collectSystemStats(),
        this.collectDiskIfNeeded(settings),
      ]);

      if (this.disposed || !this.appSettingsState.state.machineStats.enabled) {
        return;
      }

      this.state.updateState((state) => {
        state.updatedAt = Date.now();
        state.cpuLoadPercent = normalizeMetric(currentLoad.currentLoad);
        state.memoryUsedBytes = normalizeMetric(mem.used);
        state.memoryTotalBytes = normalizeMetric(mem.total);
        if (disk !== undefined) {
          state.diskUsedBytes = disk?.usedBytes ?? null;
          state.diskTotalBytes = disk?.totalBytes ?? null;
        }
        state.error = null;
      });
    } catch (error) {
      log.warn("Machine stats collection failed", error);
      if (this.disposed) return;

      this.state.updateState((state) => {
        state.updatedAt = Date.now();
        state.cpuLoadPercent = null;
        state.memoryUsedBytes = null;
        state.memoryTotalBytes = null;
        state.diskUsedBytes = null;
        state.diskTotalBytes = null;
        state.error =
          error instanceof Error ? error.message : "Failed to collect stats";
      });
    } finally {
      this.collectInFlight = false;
      this.scheduleNextCollect();
    }
  }

  private async collectDiskIfNeeded(
    settings: MachineStatsSettings,
  ): Promise<DiskUsage | null | undefined> {
    const now = Date.now();
    const intervalMs = settings.diskPollIntervalSeconds * 1000;
    if (
      this.lastDiskCollectedAt > 0 &&
      now - this.lastDiskCollectedAt < intervalMs
    ) {
      return undefined;
    }

    this.lastDiskCollectedAt = now;
    return await collectDiskUsage();
  }
}

async function collectSystemStats() {
  const si = await import("systeminformation");
  const [currentLoad, mem] = await Promise.all([si.currentLoad(), si.mem()]);
  return { currentLoad, mem };
}

export interface DiskUsage {
  usedBytes: number;
  totalBytes: number;
}

export async function collectDiskUsage(): Promise<DiskUsage | null> {
  try {
    const si = await import("systeminformation");
    const filesystems = await si.fsSize();
    const primary = pickPrimaryFilesystem(filesystems);
    if (!primary) return null;

    const usedBytes = normalizeMetric(primary.used);
    const totalBytes = normalizeMetric(primary.size);
    if (usedBytes === null || totalBytes === null) return null;

    return { usedBytes, totalBytes };
  } catch (error) {
    log.debug("Disk usage unavailable", error);
    return null;
  }
}

interface FilesystemSize {
  mount: string;
  size: number;
  used: number;
}

function pickPrimaryFilesystem<T extends FilesystemSize>(
  filesystems: T[],
): T | null {
  const mounted = filesystems.filter((fs) => normalizeMetric(fs.size));
  if (mounted.length === 0) return null;

  const preferredMounts =
    process.platform === "darwin"
      ? ["/System/Volumes/Data", "/"]
      : process.platform === "win32"
        ? [process.cwd().slice(0, 2).toUpperCase()]
        : ["/"];

  for (const mount of preferredMounts) {
    const match = mounted.find(
      (fs) => fs.mount.toUpperCase() === mount.toUpperCase(),
    );
    if (match) return match;
  }

  return mounted.reduce((largest, fs) =>
    fs.size > largest.size ? fs : largest,
  );
}

function normalizeMetric(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
