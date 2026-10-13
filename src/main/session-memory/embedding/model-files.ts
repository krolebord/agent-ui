import { createHash } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export interface ModelFileSpec {
  path: string;
  size: number;
  sha256: string;
}

export interface ModelSpec {
  repo: string;
  revision: string;
  files: readonly ModelFileSpec[];
}

export const EMBEDDING_MODEL_FILE = "onnx/model_quantized.onnx";
export const EMBEDDING_TOKENIZER_FILE = "tokenizer.json";

export const EMBEDDING_MODEL: ModelSpec = {
  repo: "onnx-community/embeddinggemma-2-ONNX",
  revision: "daa72c51243991dfcaf9f9137d2c573d8f7790c0",
  files: [
    {
      path: EMBEDDING_MODEL_FILE,
      size: 495_165,
      sha256:
        "d06edd601f851c633a2519304cbeb8dc6170d7ceb61b436625c17fb9b6e74953",
    },
    {
      path: "onnx/model_quantized.onnx_data",
      size: 313_724_928,
      sha256:
        "278a7ff1248c3618e4bd11a607fc54f7bdc7778854230f3956d3f86bd9db4f3b",
    },
    {
      path: EMBEDDING_TOKENIZER_FILE,
      size: 32_170_510,
      sha256:
        "4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4",
    },
  ],
};

export function getEmbeddingModelDir(userDataPath: string): string {
  return path.join(
    userDataPath,
    "models",
    `embeddinggemma-2-onnx-q8-${EMBEDDING_MODEL.revision.slice(0, 12)}`,
  );
}

export interface ModelDownloadProgress {
  file: string;
  fileBytes: number;
  fileTotal: number;
  bytesDone: number;
  bytesTotal: number;
}

export type ModelFilesStatus =
  | { state: "missing" }
  | { state: "downloading"; progress: ModelDownloadProgress }
  | { state: "ready" }
  | { state: "error"; message: string };

export interface ModelFilesManagerOptions {
  modelDir: string;
  model?: ModelSpec;
  baseUrl?: string;
  fetch?: typeof fetch;
  progressIntervalMs?: number;
  now?: () => number;
  onStatusChange?: (status: ModelFilesStatus) => void;
}

export interface DownloadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ModelDownloadProgress) => void;
}

const DEFAULT_BASE_URL = "https://huggingface.co";
const DEFAULT_PROGRESS_INTERVAL_MS = 250;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Final file paths only ever receive verified content via rename, so a file
 * with the expected size is treated as verified without re-hashing it.
 */
export class ModelFilesManager {
  readonly modelDir: string;
  private readonly model: ModelSpec;
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly progressIntervalMs: number;
  private readonly now: () => number;
  private readonly onStatusChange?: (status: ModelFilesStatus) => void;
  private status: ModelFilesStatus = { state: "missing" };
  private download: Promise<void> | null = null;

  constructor(options: ModelFilesManagerOptions) {
    this.modelDir = options.modelDir;
    this.model = options.model ?? EMBEDDING_MODEL;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.progressIntervalMs =
      options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.onStatusChange = options.onStatusChange;
  }

  getStatus(): ModelFilesStatus {
    return this.status;
  }

  filePath(file: string): string {
    return path.join(this.modelDir, file);
  }

  fileUrl(file: string): string {
    return `${this.baseUrl}/${this.model.repo}/resolve/${this.model.revision}/${file}`;
  }

  async refresh(): Promise<ModelFilesStatus> {
    if (this.download) {
      return this.status;
    }
    const present = await Promise.all(
      this.model.files.map((file) => this.isPresent(file)),
    );
    if (!this.download) {
      this.setStatus(
        present.every(Boolean) ? { state: "ready" } : { state: "missing" },
      );
    }
    return this.status;
  }

  /** Concurrent callers share the in-flight download and its signal. */
  ensureDownloaded(options: DownloadOptions = {}): Promise<void> {
    this.download ??= this.runDownload(options).finally(() => {
      this.download = null;
    });
    return this.download;
  }

  private async runDownload({
    signal,
    onProgress,
  }: DownloadOptions): Promise<void> {
    const bytesTotal = this.model.files.reduce(
      (sum, file) => sum + file.size,
      0,
    );
    let bytesDone = 0;
    let lastReportAt = Number.NEGATIVE_INFINITY;
    const report = (
      progress: Omit<ModelDownloadProgress, "bytesTotal">,
      force: boolean,
    ) => {
      const now = this.now();
      if (!force && now - lastReportAt < this.progressIntervalMs) {
        return;
      }
      lastReportAt = now;
      const full = { ...progress, bytesTotal };
      this.setStatus({ state: "downloading", progress: full });
      onProgress?.(full);
    };

    try {
      for (const file of this.model.files) {
        signal?.throwIfAborted();
        report(
          {
            file: file.path,
            fileBytes: 0,
            fileTotal: file.size,
            bytesDone,
          },
          true,
        );
        if (!(await this.isPresent(file))) {
          const base = bytesDone;
          await this.downloadFile(file, signal, (fileBytes) =>
            report(
              {
                file: file.path,
                fileBytes,
                fileTotal: file.size,
                bytesDone: base + fileBytes,
              },
              false,
            ),
          );
        }
        bytesDone += file.size;
        report(
          {
            file: file.path,
            fileBytes: file.size,
            fileTotal: file.size,
            bytesDone,
          },
          true,
        );
      }
      this.setStatus({ state: "ready" });
    } catch (error) {
      this.setStatus(
        signal?.aborted
          ? { state: "missing" }
          : { state: "error", message: errorMessage(error) },
      );
      throw error;
    }
  }

  private async isPresent(file: ModelFileSpec): Promise<boolean> {
    const stats = await stat(this.filePath(file.path)).catch(() => null);
    return stats?.isFile() === true && stats.size === file.size;
  }

  private async downloadFile(
    file: ModelFileSpec,
    signal: AbortSignal | undefined,
    onBytes: (fileBytes: number) => void,
  ): Promise<void> {
    const target = this.filePath(file.path);
    const temp = `${target}.partial`;
    await mkdir(path.dirname(target), { recursive: true });

    const handle = await open(temp, "w");
    try {
      const response = await this.fetch(this.fileUrl(file.path), { signal });
      if (!response.ok || !response.body) {
        throw new Error(
          `Download of ${file.path} failed: HTTP ${response.status}`,
        );
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && Number(contentLength) !== file.size) {
        throw new Error(
          `Download of ${file.path} has size ${contentLength}, expected ${file.size}`,
        );
      }

      const hash = createHash("sha256");
      let fileBytes = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fileBytes += value.byteLength;
          if (fileBytes > file.size) {
            throw new Error(
              `Download of ${file.path} exceeds expected size ${file.size}`,
            );
          }
          hash.update(value);
          await handle.write(value);
          onBytes(fileBytes);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      signal?.throwIfAborted();
      if (fileBytes !== file.size) {
        throw new Error(
          `Download of ${file.path} has size ${fileBytes}, expected ${file.size}`,
        );
      }
      const digest = hash.digest("hex");
      if (digest !== file.sha256) {
        throw new Error(
          `Download of ${file.path} has sha256 ${digest}, expected ${file.sha256}`,
        );
      }
      await handle.close();
      await rename(temp, target);
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(temp, { force: true });
      throw error;
    }
  }

  private setStatus(status: ModelFilesStatus) {
    this.status = status;
    this.onStatusChange?.(status);
  }
}
