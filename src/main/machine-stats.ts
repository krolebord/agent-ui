import { defineServiceState } from "@shared/service-state";
import type { AppSettingsState, MachineStatsSettings } from "./app-settings";
import log from "./logger";

export interface MachineStatsState {
  updatedAt: number | null;
  cpuLoadPercent: number | null;
  cpuTemperatureCelsius: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  error: string | null;
}

const machineStatsDefaults: MachineStatsState = {
  updatedAt: null,
  cpuLoadPercent: null,
  cpuTemperatureCelsius: null,
  memoryUsedBytes: null,
  memoryTotalBytes: null,
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
  private lastTemperatureCollectedAt = 0;

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
    this.lastTemperatureCollectedAt = 0;
    this.state.updateState((state) => {
      state.updatedAt = null;
      state.cpuLoadPercent = null;
      state.cpuTemperatureCelsius = null;
      state.memoryUsedBytes = null;
      state.memoryTotalBytes = null;
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

      const [{ currentLoad, mem }, cpuTemperatureCelsius] = await Promise.all([
        collectSystemStats(),
        this.collectTemperatureIfNeeded(settings),
      ]);

      if (this.disposed || !this.appSettingsState.state.machineStats.enabled) {
        return;
      }

      this.state.updateState((state) => {
        state.updatedAt = Date.now();
        state.cpuLoadPercent = normalizeMetric(currentLoad.currentLoad);
        if (cpuTemperatureCelsius !== undefined) {
          state.cpuTemperatureCelsius = cpuTemperatureCelsius;
        }
        state.memoryUsedBytes = normalizeMetric(mem.used);
        state.memoryTotalBytes = normalizeMetric(mem.total);
        state.error = null;
      });
    } catch (error) {
      log.warn("Machine stats collection failed", error);
      if (this.disposed) return;

      this.state.updateState((state) => {
        state.updatedAt = Date.now();
        state.cpuLoadPercent = null;
        state.cpuTemperatureCelsius = null;
        state.memoryUsedBytes = null;
        state.memoryTotalBytes = null;
        state.error =
          error instanceof Error ? error.message : "Failed to collect stats";
      });
    } finally {
      this.collectInFlight = false;
      this.scheduleNextCollect();
    }
  }

  private async collectTemperatureIfNeeded(
    settings: MachineStatsSettings,
  ): Promise<number | null | undefined> {
    const now = Date.now();
    const intervalMs = settings.temperaturePollIntervalSeconds * 1000;
    if (
      this.lastTemperatureCollectedAt > 0 &&
      now - this.lastTemperatureCollectedAt < intervalMs
    ) {
      return undefined;
    }

    this.lastTemperatureCollectedAt = now;
    return await collectCpuTemperatureCelsius();
  }
}

async function collectSystemStats() {
  const si = await import("systeminformation");
  const [currentLoad, mem] = await Promise.all([si.currentLoad(), si.mem()]);
  return { currentLoad, mem };
}

export async function collectCpuTemperatureCelsius(): Promise<number | null> {
  if (process.platform === "linux") {
    try {
      const si = await import("systeminformation");
      const temperature = await si.cpuTemperature();
      return (
        normalizeMetric(temperature.main) ?? normalizeMetric(temperature.max)
      );
    } catch (error) {
      log.debug("CPU temperature unavailable", error);
      return null;
    }
  }

  if (process.platform === "darwin") {
    try {
      const macosTemperatureSensor = await import("macos-temperature-sensor");
      return normalizeMetric(macosTemperatureSensor.temperature().cpu);
    } catch (error) {
      log.debug("CPU temperature unavailable", error);
      return null;
    }
  }

  return null;
}

function normalizeMetric(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
