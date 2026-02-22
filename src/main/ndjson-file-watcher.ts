import { type FSWatcher, watch } from "node:fs";
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { z } from "zod";

const DEFAULT_POLL_INTERVAL_MS = 180;
const DEFAULT_POLL_STALE_CHECK_MS = 250;
const MAX_READ_CHUNK_BYTES = 64 * 1024;

export interface NdjsonFileWatcherOptions<TParsed = unknown> {
  filePath: string;
  onData: (data: TParsed) => void | Promise<void>;
  schema?: z.ZodType<TParsed>;
  onError?: (error: unknown) => void;
  pollIntervalMs?: number;
  pollStaleCheckMs?: number;
  startFromBeginning?: boolean;
}

export class NdjsonFileWatcher<TParsed = unknown> {
  private readonly filePath: string;
  private readonly onData: (data: TParsed) => void | Promise<void>;
  private readonly schema?: z.ZodType<TParsed>;
  private readonly onError?: (error: unknown) => void;
  private readonly pollIntervalMs: number;
  private readonly pollStaleCheckMs: number;
  private readonly startFromBeginning: boolean;

  private started = false;
  private generation = 0;
  private fileOffset = 0;
  private buffer = "";
  private watcher: FSWatcher | null = null;
  private pollingIntervalId: NodeJS.Timeout | null = null;
  private isPolling = false;
  private pollDonePromise: Promise<void> | null = null;
  private pollRequested = false;
  private lastPollingCheckAt = 0;
  private usingPollingFallback = false;
  private utf8Decoder = new StringDecoder("utf8");

  constructor(options: NdjsonFileWatcherOptions<TParsed>) {
    this.filePath = options.filePath;
    this.onData = options.onData;
    this.schema = options.schema;
    this.onError = options.onError;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollStaleCheckMs =
      options.pollStaleCheckMs ?? DEFAULT_POLL_STALE_CHECK_MS;
    this.startFromBeginning = options.startFromBeginning ?? false;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    this.generation++;
    this.fileOffset = 0;
    this.buffer = "";
    this.isPolling = false;
    this.pollDonePromise = null;
    this.pollRequested = false;
    this.lastPollingCheckAt = 0;
    this.usingPollingFallback = false;
    this.utf8Decoder = new StringDecoder("utf8");

    try {
      await this.ensureFile();
      const fileStats = await stat(this.filePath).catch(() => null);
      this.fileOffset = this.startFromBeginning ? 0 : (fileStats?.size ?? 0);

      this.startPollingInterval();

      try {
        this.startWatcher();
      } catch (error) {
        this.reportError(error);
        this.usingPollingFallback = true;
      }

      void this.requestPoll();
    } catch (error) {
      this.stopWatcher();
      this.started = false;
      this.pollRequested = false;
      this.fileOffset = 0;
      this.buffer = "";
      this.isPolling = false;
      this.pollDonePromise = null;
      this.lastPollingCheckAt = 0;
      this.usingPollingFallback = false;
      this.utf8Decoder = new StringDecoder("utf8");
      this.reportError(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopWatcher();

    this.started = false;
    this.pollRequested = false;

    if (this.pollDonePromise) {
      await this.pollDonePromise;
    }

    this.fileOffset = 0;
    this.buffer = "";
    this.isPolling = false;
    this.pollDonePromise = null;
    this.lastPollingCheckAt = 0;
    this.usingPollingFallback = false;
    this.utf8Decoder = new StringDecoder("utf8");
  }

  private async ensureFile(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, "", { encoding: "utf8", flag: "a" });
  }

  private startPollingInterval(): void {
    if (this.pollingIntervalId) {
      return;
    }

    this.pollingIntervalId = setInterval(() => {
      if (!this.started) {
        return;
      }

      const now = Date.now();
      const isPollingCheckStale =
        now - this.lastPollingCheckAt > this.pollStaleCheckMs;

      if (isPollingCheckStale || this.usingPollingFallback) {
        void this.requestPoll();
      }
    }, this.pollIntervalMs);
  }

  private startWatcher(): void {
    this.watcher = watch(this.filePath, () => {
      void this.requestPoll();
    });

    this.watcher.on("error", (error) => {
      this.reportError(error);
      this.usingPollingFallback = true;
    });
  }

  private stopWatcher(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (this.pollingIntervalId) {
      clearInterval(this.pollingIntervalId);
      this.pollingIntervalId = null;
    }
  }

  private requestPoll(): Promise<void> {
    this.pollRequested = true;

    if (this.isPolling || !this.started) {
      return this.pollDonePromise ?? Promise.resolve();
    }

    this.isPolling = true;
    const generation = this.generation;

    this.pollDonePromise = (async () => {
      try {
        while (
          this.pollRequested &&
          this.started &&
          this.generation === generation
        ) {
          this.pollRequested = false;
          await this.pollOnce();
        }
      } finally {
        this.isPolling = false;
      }
    })();

    return this.pollDonePromise;
  }

  private async pollOnce(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.lastPollingCheckAt = Date.now();

    const fileStats = await stat(this.filePath).catch(() => null);
    if (!fileStats) {
      try {
        await this.ensureFile();
      } catch (error) {
        this.reportError(error);
      }
      return;
    }

    if (fileStats.size < this.fileOffset) {
      this.fileOffset = 0;
      this.buffer = "";
      this.utf8Decoder = new StringDecoder("utf8");
    }

    if (fileStats.size === this.fileOffset) {
      return;
    }

    const handle = await open(this.filePath, "r").catch(() => null);
    if (!handle) {
      return;
    }

    try {
      let remainingBytes = fileStats.size - this.fileOffset;
      while (remainingBytes > 0 && this.started) {
        const nextChunkBytes = Math.min(remainingBytes, MAX_READ_CHUNK_BYTES);
        const chunkBuffer = Buffer.allocUnsafe(nextChunkBytes);
        const { bytesRead } = await handle.read(
          chunkBuffer,
          0,
          nextChunkBytes,
          this.fileOffset,
        );

        if (!bytesRead) {
          break;
        }

        this.fileOffset += bytesRead;
        remainingBytes -= bytesRead;

        const decodedChunk = this.utf8Decoder.write(
          chunkBuffer.subarray(0, bytesRead),
        );
        if (decodedChunk) {
          await this.processChunk(decodedChunk);
        }
      }
    } catch (error) {
      this.reportError(error);
    } finally {
      await handle.close().catch((error) => {
        this.reportError(error);
      });
    }
  }

  private async processChunk(chunk: string): Promise<void> {
    this.buffer += chunk;

    while (true) {
      const newLineIndex = this.buffer.indexOf("\n");
      if (newLineIndex < 0) {
        break;
      }

      const line = this.buffer.slice(0, newLineIndex).trim();
      this.buffer = this.buffer.slice(newLineIndex + 1);

      if (!line) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (!this.schema) {
        await this.emitData(parsed as TParsed);
        continue;
      }

      const result = this.schema.safeParse(parsed);
      if (!result.success) {
        this.reportError(result.error);
        continue;
      }

      await this.emitData(result.data);
    }
  }

  private async emitData(data: TParsed): Promise<void> {
    try {
      await this.onData(data);
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    if (!this.onError) {
      return;
    }

    try {
      this.onError(error);
    } catch {
      // Best effort only: never allow error-report callbacks to break watcher internals.
    }
  }
}
