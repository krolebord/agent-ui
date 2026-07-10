import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const systemInformationMocks = vi.hoisted(() => ({
  cpuTemperature: vi.fn(),
}));
const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("systeminformation", () => systemInformationMocks);
vi.mock("../../src/main/logger", () => ({
  default: loggerMocks,
}));

import { collectCpuTemperatureCelsius } from "../../src/main/machine-stats";

const originalPlatform = process.platform;

describe("MachineStatsMonitor on Linux", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });
    systemInformationMocks.cpuTemperature.mockResolvedValue({
      main: 54,
      max: 61,
      cores: [],
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("collects CPU temperature through systeminformation", async () => {
    expect(process.platform).toBe("linux");
    const temperature = await collectCpuTemperatureCelsius();

    expect(temperature).toBe(54);
    expect(loggerMocks.debug).not.toHaveBeenCalled();
    expect(systemInformationMocks.cpuTemperature).toHaveBeenCalledOnce();
  });
});
