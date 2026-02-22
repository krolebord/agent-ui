import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { NdjsonFileWatcher } from "../../src/main/ndjson-file-watcher";

const POLL_INTERVAL_MS = 20;
const POLL_STALE_CHECK_MS = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function appendRaw(filePath: string, value: string): Promise<void> {
  await writeFile(filePath, value, { encoding: "utf8", flag: "a" });
}

describe("NdjsonFileWatcher", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "ndjson-file-watcher-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates the file when it does not exist", async () => {
    const filePath = path.join(tempDir, "nested", "events.ndjson");

    const watcher = new NdjsonFileWatcher({
      filePath,
      onData: vi.fn(),
      pollIntervalMs: POLL_INTERVAL_MS,
      pollStaleCheckMs: POLL_STALE_CHECK_MS,
    });

    await watcher.start();
    await watcher.stop();

    expect(existsSync(filePath)).toBe(true);
  });

  it("starts from EOF and emits only newly appended records", async () => {
    const filePath = path.join(tempDir, "events.ndjson");
    await writeFile(
      filePath,
      `${JSON.stringify({ id: 1 })}\n${JSON.stringify({ id: 2 })}\n`,
      "utf8",
    );

    const received: Array<{ id: number }> = [];
    const watcher = new NdjsonFileWatcher<{ id: number }>({
      filePath,
      onData: (event) => {
        received.push(event);
      },
      pollIntervalMs: POLL_INTERVAL_MS,
      pollStaleCheckMs: POLL_STALE_CHECK_MS,
    });

    await watcher.start();
    await sleep(80);
    expect(received).toEqual([]);

    await appendRaw(filePath, `${JSON.stringify({ id: 3 })}\n`);

    await vi.waitFor(() => {
      expect(received).toEqual([{ id: 3 }]);
    });
    await watcher.stop();
  });

  it("can start from beginning and emit existing records", async () => {
    const filePath = path.join(tempDir, "events.ndjson");
    await writeFile(
      filePath,
      `${JSON.stringify({ id: 1 })}\n${JSON.stringify({ id: 2 })}\n`,
      "utf8",
    );

    const received: Array<{ id: number }> = [];
    const watcher = new NdjsonFileWatcher<{ id: number }>({
      filePath,
      onData: (event) => {
        received.push(event);
      },
      startFromBeginning: true,
      pollIntervalMs: POLL_INTERVAL_MS,
      pollStaleCheckMs: POLL_STALE_CHECK_MS,
    });

    await watcher.start();
    await vi.waitFor(() => {
      expect(received).toEqual([{ id: 1 }, { id: 2 }]);
    });
    await watcher.stop();
  });

  it("parses appended records and skips invalid JSON lines", async () => {
    const filePath = path.join(tempDir, "events.ndjson");
    const received: Array<{ id: number }> = [];

    const watcher = new NdjsonFileWatcher<{ id: number }>({
      filePath,
      onData: (event) => {
        received.push(event);
      },
      pollIntervalMs: POLL_INTERVAL_MS,
      pollStaleCheckMs: POLL_STALE_CHECK_MS,
    });

    await watcher.start();
    await appendRaw(
      filePath,
      `{invalid json}\n${JSON.stringify({ id: 11 })}\n${JSON.stringify({ id: 12 })}\n`,
    );

    await vi.waitFor(() => {
      expect(received).toEqual([{ id: 11 }, { id: 12 }]);
    });
    await watcher.stop();
  });

  it("applies optional zod schema and skips invalid payloads", async () => {
    const filePath = path.join(tempDir, "events.ndjson");
    const eventSchema = z.object({
      type: z.literal("event"),
      count: z.number().int(),
    });

    const received: Array<z.infer<typeof eventSchema>> = [];
    const watcher = new NdjsonFileWatcher<z.infer<typeof eventSchema>>({
      filePath,
      schema: eventSchema,
      onData: (event) => {
        received.push(event);
      },
      pollIntervalMs: POLL_INTERVAL_MS,
      pollStaleCheckMs: POLL_STALE_CHECK_MS,
    });

    await watcher.start();
    await appendRaw(
      filePath,
      `${JSON.stringify({ type: "event", count: 1 })}\n${JSON.stringify({ type: "event", count: "bad" })}\n${JSON.stringify({ type: "other", count: 5 })}\n`,
    );

    await vi.waitFor(() => {
      expect(received).toEqual([{ type: "event", count: 1 }]);
    });
    await watcher.stop();
  });

  it("buffers partial lines until newline is appended", async () => {
    const filePath = path.join(tempDir, "events.ndjson");
    const received: Array<{ id: number }> = [];

    const watcher = new NdjsonFileWatcher<{ id: number }>({
      filePath,
      onData: (event) => {
        received.push(event);
      },
      pollIntervalMs: POLL_INTERVAL_MS,
      pollStaleCheckMs: POLL_STALE_CHECK_MS,
    });

    await watcher.start();

    await appendRaw(filePath, JSON.stringify({ id: 21 }));
    await sleep(120);
    expect(received).toEqual([]);

    await appendRaw(filePath, "\n");
    await vi.waitFor(() => {
      expect(received).toEqual([{ id: 21 }]);
    });
    await watcher.stop();
  });

  it("recovers from truncation and continues tailing new records", async () => {
    const filePath = path.join(tempDir, "events.ndjson");
    const received: Array<{ id: number }> = [];

    const watcher = new NdjsonFileWatcher<{ id: number }>({
      filePath,
      onData: (event) => {
        received.push(event);
      },
      pollIntervalMs: POLL_INTERVAL_MS,
      pollStaleCheckMs: POLL_STALE_CHECK_MS,
    });

    await watcher.start();

    await appendRaw(filePath, `${JSON.stringify({ id: 31 })}\n`);
    await vi.waitFor(() => {
      expect(received).toEqual([{ id: 31 }]);
    });

    await writeFile(filePath, "", "utf8");
    await appendRaw(filePath, `${JSON.stringify({ id: 32 })}\n`);

    await vi.waitFor(() => {
      expect(received).toEqual([{ id: 31 }, { id: 32 }]);
    });
    await watcher.stop();
  });

  it("stops emitting records after stop is called", async () => {
    const filePath = path.join(tempDir, "events.ndjson");
    const received: Array<{ id: number }> = [];

    const watcher = new NdjsonFileWatcher<{ id: number }>({
      filePath,
      onData: (event) => {
        received.push(event);
      },
      pollIntervalMs: POLL_INTERVAL_MS,
      pollStaleCheckMs: POLL_STALE_CHECK_MS,
    });

    await watcher.start();
    await watcher.stop();

    await appendRaw(filePath, `${JSON.stringify({ id: 41 })}\n`);
    await sleep(120);

    expect(received).toEqual([]);
  });

  it("can start again after an initial start failure", async () => {
    const blockedPath = path.join(tempDir, "blocked");
    await writeFile(blockedPath, "file-not-directory", "utf8");
    const filePath = path.join(blockedPath, "events.ndjson");
    const onError = vi.fn();

    const watcher = new NdjsonFileWatcher<{ id: number }>({
      filePath,
      onData: vi.fn(),
      onError,
      pollIntervalMs: POLL_INTERVAL_MS,
      pollStaleCheckMs: POLL_STALE_CHECK_MS,
    });

    await expect(watcher.start()).rejects.toThrow();

    await rm(blockedPath, { force: true });
    await mkdir(blockedPath, { recursive: true });

    await expect(watcher.start()).resolves.toBeUndefined();
    await watcher.stop();

    expect(onError).toHaveBeenCalled();
    expect(existsSync(filePath)).toBe(true);
  });

  it("handles large multibyte records that span multiple file reads", async () => {
    const filePath = path.join(tempDir, "events.ndjson");
    const payload = { text: "€".repeat(30_000) };
    const received: Array<typeof payload> = [];

    const watcher = new NdjsonFileWatcher<typeof payload>({
      filePath,
      onData: (event) => {
        received.push(event);
      },
      pollIntervalMs: POLL_INTERVAL_MS,
      pollStaleCheckMs: POLL_STALE_CHECK_MS,
    });

    await watcher.start();
    await appendRaw(filePath, `${JSON.stringify(payload)}\n`);

    await vi.waitFor(() => {
      expect(received).toEqual([payload]);
    });
    await watcher.stop();
  });

  it("continues polling when onError callback throws", async () => {
    const filePath = path.join(tempDir, "events.ndjson");
    const eventSchema = z.object({ id: z.number() });
    const received: Array<{ id: number }> = [];
    const onError = vi.fn(() => {
      throw new Error("onError failed");
    });

    const watcher = new NdjsonFileWatcher<{ id: number }>({
      filePath,
      schema: eventSchema,
      onData: (event) => {
        received.push(event);
      },
      onError,
      pollIntervalMs: POLL_INTERVAL_MS,
      pollStaleCheckMs: POLL_STALE_CHECK_MS,
    });

    await watcher.start();
    await appendRaw(filePath, `${JSON.stringify({ id: "bad" })}\n`);
    await appendRaw(filePath, `${JSON.stringify({ id: 51 })}\n`);

    await vi.waitFor(() => {
      expect(received).toEqual([{ id: 51 }]);
    });
    await watcher.stop();

    expect(onError).toHaveBeenCalled();
  });
});
