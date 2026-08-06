import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForShutdownWithTimeout } from "../../src/main/app-runtime";

describe("waitForShutdownWithTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for shutdown work that completes within the cap", async () => {
    await expect(
      waitForShutdownWithTimeout(Promise.resolve(), 100),
    ).resolves.toBe(true);
  });

  it("stops waiting when shutdown exceeds the cap", async () => {
    vi.useFakeTimers();
    const result = waitForShutdownWithTimeout(new Promise<void>(() => {}), 100);

    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toBe(false);
  });
});
