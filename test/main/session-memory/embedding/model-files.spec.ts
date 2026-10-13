import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMBEDDING_MODEL,
  getEmbeddingModelDir,
  type ModelDownloadProgress,
  ModelFilesManager,
  type ModelFilesStatus,
  type ModelSpec,
} from "../../../../src/main/session-memory/embedding/model-files";

const CHUNK_BYTES = 4;

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

const contents: Record<string, Buffer> = {
  "onnx/model.onnx": Buffer.from("model graph bytes"),
  "tokenizer.json": Buffer.from('{"tokenizer":true}'),
};

const model: ModelSpec = {
  repo: "org/model",
  revision: "abc123",
  files: Object.entries(contents).map(([file, content]) => ({
    path: file,
    size: content.length,
    sha256: sha256(content),
  })),
};

function chunkedBody(content: Buffer, onChunk?: (index: number) => void) {
  let offset = 0;
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= content.length) {
        controller.close();
        return;
      }
      onChunk?.(index++);
      controller.enqueue(
        new Uint8Array(content.subarray(offset, offset + CHUNK_BYTES)),
      );
      offset += CHUNK_BYTES;
    },
  });
}

function fileFromUrl(url: string): string {
  const prefix = "https://hf.test/org/model/resolve/abc123/";
  expect(url.startsWith(prefix)).toBe(true);
  return url.slice(prefix.length);
}

function serve(overrides: Record<string, Buffer> = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const file = fileFromUrl(String(input));
    const content = overrides[file] ?? contents[file];
    return new Response(chunkedBody(content));
  });
}

describe("ModelFilesManager", () => {
  let modelDir: string;
  let statuses: ModelFilesStatus[];

  beforeEach(async () => {
    modelDir = await mkdtemp(path.join(tmpdir(), "embedding-model-files-"));
    statuses = [];
  });

  afterEach(async () => {
    await rm(modelDir, { recursive: true, force: true });
  });

  function createManager(fetchImpl: typeof fetch) {
    return new ModelFilesManager({
      modelDir,
      model,
      baseUrl: "https://hf.test",
      fetch: fetchImpl,
      progressIntervalMs: 0,
      onStatusChange: (status) => statuses.push(status),
    });
  }

  it("pins the EmbeddingGemma 2 Q8 files at a fixed revision", () => {
    expect(EMBEDDING_MODEL.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(EMBEDDING_MODEL.files.map((file) => file.path)).toEqual([
      "onnx/model_quantized.onnx",
      "onnx/model_quantized.onnx_data",
      "tokenizer.json",
    ]);
    for (const file of EMBEDDING_MODEL.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(getEmbeddingModelDir("/data")).toBe(
      "/data/models/embeddinggemma-2-onnx-q8-daa72c512439",
    );
  });

  it("downloads, verifies and renames every file into place", async () => {
    const fetchImpl = serve();
    const manager = createManager(fetchImpl);
    expect(await manager.refresh()).toEqual({ state: "missing" });

    const progress: ModelDownloadProgress[] = [];
    await manager.ensureDownloaded({
      onProgress: (item) => progress.push(item),
    });

    expect(manager.getStatus()).toEqual({ state: "ready" });
    for (const [file, content] of Object.entries(contents)) {
      expect(await readFile(path.join(modelDir, file))).toEqual(content);
    }
    expect(await readdir(path.join(modelDir, "onnx"))).toEqual(["model.onnx"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const total = model.files.reduce((sum, file) => sum + file.size, 0);
    expect(progress.at(-1)).toEqual({
      file: "tokenizer.json",
      fileBytes: contents["tokenizer.json"].length,
      fileTotal: contents["tokenizer.json"].length,
      bytesDone: total,
      bytesTotal: total,
    });
    const overall = progress.map((item) => item.bytesDone);
    expect(overall).toEqual([...overall].sort((a, b) => a - b));
    expect(statuses.at(-1)).toEqual({ state: "ready" });
    expect(await createManager(serve()).refresh()).toEqual({ state: "ready" });
  });

  it("does not expose the final path until the file is verified", async () => {
    const target = path.join(modelDir, "onnx/model.onnx");
    const seen: boolean[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const file = fileFromUrl(String(input));
      return new Response(
        chunkedBody(contents[file], () => seen.push(existsSync(target))),
      );
    });

    await createManager(fetchImpl).ensureDownloaded();

    expect(seen.length).toBeGreaterThan(2);
    expect(seen.slice(0, 3)).toEqual([false, false, false]);
  });

  it("skips files that are already present with the expected size", async () => {
    await mkdir(path.join(modelDir, "onnx"), { recursive: true });
    await writeFile(
      path.join(modelDir, "onnx/model.onnx"),
      contents["onnx/model.onnx"],
    );
    const fetchImpl = serve();

    await createManager(fetchImpl).ensureDownloaded();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("tokenizer.json");
  });

  it("rejects a hash mismatch and removes the temporary file", async () => {
    const corrupted = Buffer.from(contents["tokenizer.json"]);
    corrupted[0] ^= 0xff;
    const manager = createManager(serve({ "tokenizer.json": corrupted }));

    await expect(manager.ensureDownloaded()).rejects.toThrow(
      /tokenizer\.json has sha256 [0-9a-f]+, expected/,
    );

    expect(manager.getStatus()).toMatchObject({ state: "error" });
    expect(await readdir(modelDir)).toEqual(["onnx"]);
    expect(await manager.refresh()).toEqual({ state: "missing" });
  });

  it("rejects bodies that are shorter or longer than expected", async () => {
    const short = createManager(
      serve({ "onnx/model.onnx": Buffer.from("short") }),
    );
    await expect(short.ensureDownloaded()).rejects.toThrow(
      /has size 5, expected 17/,
    );

    const long = createManager(
      serve({ "onnx/model.onnx": Buffer.from("x".repeat(40)) }),
    );
    await expect(long.ensureDownloaded()).rejects.toThrow(
      "exceeds expected size 17",
    );
    expect(await readdir(path.join(modelDir, "onnx"))).toEqual([]);
  });

  it("rejects a mismatched content-length before reading the body", async () => {
    const manager = createManager(
      vi.fn(
        async () => new Response("abc", { headers: { "content-length": "3" } }),
      ),
    );
    await expect(manager.ensureDownloaded()).rejects.toThrow(
      "has size 3, expected 17",
    );
  });

  it("reports HTTP errors", async () => {
    const manager = createManager(
      vi.fn(async () => new Response("nope", { status: 404 })),
    );
    await expect(manager.ensureDownloaded()).rejects.toThrow("HTTP 404");
    expect(manager.getStatus()).toEqual({
      state: "error",
      message: "Download of onnx/model.onnx failed: HTTP 404",
    });
  });

  it("aborts mid-download, cleans up and returns to missing", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const file = fileFromUrl(String(input));
        const content = contents[file];
        let offset = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(streamController) {
            if (offset === CHUNK_BYTES) controller.abort();
            init?.signal?.throwIfAborted();
            streamController.enqueue(
              new Uint8Array(content.subarray(offset, offset + CHUNK_BYTES)),
            );
            offset += CHUNK_BYTES;
          },
        });
        return new Response(body);
      },
    );
    const manager = createManager(fetchImpl);

    await expect(
      manager.ensureDownloaded({ signal: controller.signal }),
    ).rejects.toThrow();

    expect(manager.getStatus()).toEqual({ state: "missing" });
    expect(await readdir(path.join(modelDir, "onnx"))).toEqual([]);
  });

  it("shares a single in-flight download between callers", async () => {
    const fetchImpl = serve();
    const manager = createManager(fetchImpl);

    await Promise.all([manager.ensureDownloaded(), manager.ensureDownloaded()]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(manager.getStatus()).toEqual({ state: "ready" });
  });
});
