import { readFile } from "node:fs/promises";
import path from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";
import type { InferenceSession, Tensor } from "onnxruntime-node";
import { EMBEDDING_DIMENSIONS } from "./embedder";
import type { EmbeddingWorkerConfig } from "./ipc";
import { EMBEDDING_MODEL_FILE, EMBEDDING_TOKENIZER_FILE } from "./model-files";

const MEDIA_FEATURE_INPUTS = new Set([
  "image_features",
  "video_features",
  "audio_features",
]);
const MEDIA_FEATURE_WIDTH = 512;

export interface TextTokenizer {
  encode(text: string): number[];
  readonly bosId: number;
  readonly eosId: number;
}

export interface EmbeddingRuntime {
  embed(texts: string[]): Promise<Float32Array<ArrayBuffer>[]>;
  countTokens(texts: string[]): number[];
  release(): Promise<void>;
}

export async function loadTextTokenizer(
  tokenizerPath: string,
): Promise<TextTokenizer> {
  const tokenizer = new Tokenizer(
    JSON.parse(await readFile(tokenizerPath, "utf8")),
    {},
  );
  const bosId = tokenizer.token_to_id("<bos>");
  const eosId = tokenizer.token_to_id("<eos>");
  if (bosId === undefined || eosId === undefined) {
    throw new Error("Tokenizer is missing <bos> or <eos>");
  }
  return {
    bosId,
    eosId,
    encode: (text) => tokenizer.encode(text, { add_special_tokens: false }).ids,
  };
}

/** Matches Hugging Face `tokenizers` truncation, which reserves room for BOS and EOS. */
export function toModelInputIds(
  tokenizer: TextTokenizer,
  text: string,
  maxTokens: number,
): number[] {
  const ids = tokenizer.encode(text);
  return [tokenizer.bosId, ...ids.slice(0, maxTokens - 2), tokenizer.eosId];
}

export function meanPool(
  hidden: Float32Array,
  sequenceLength: number,
  width: number,
): Float32Array {
  const pooled = new Float32Array(width);
  for (let token = 0; token < sequenceLength; token++) {
    const offset = token * width;
    for (let index = 0; index < width; index++) {
      pooled[index] += hidden[offset + index];
    }
  }
  for (let index = 0; index < width; index++) {
    pooled[index] /= sequenceLength;
  }
  return pooled;
}

export function l2Normalize(vector: Float32Array): Float32Array<ArrayBuffer> {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new Error("Embedding has zero or non-finite norm");
  }
  const normalized = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index++) {
    normalized[index] = vector[index] / norm;
  }
  return normalized;
}

async function createEmbeddingSession(
  ort: typeof import("onnxruntime-node"),
  modelPath: string,
  threads: number,
): Promise<InferenceSession> {
  return await ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    executionMode: "sequential",
    graphOptimizationLevel: "all",
    extra: { session: { intra_op: { allow_spinning: "0" } } },
  });
}

export async function loadEmbeddingRuntime(
  config: EmbeddingWorkerConfig,
): Promise<EmbeddingRuntime> {
  const tokenizer = await loadTextTokenizer(
    path.join(config.modelDir, EMBEDDING_TOKENIZER_FILE),
  );
  // Loaded lazily so importing this module never needs the native binding.
  const ort = await import("onnxruntime-node");
  const { Tensor } = ort;
  const session = await createEmbeddingSession(
    ort,
    path.join(config.modelDir, EMBEDDING_MODEL_FILE),
    config.threads,
  );
  const outputName = session.outputNames.includes("sentence_embedding")
    ? "sentence_embedding"
    : "last_hidden_state";
  if (!session.outputNames.includes(outputName)) {
    throw new Error(
      `Unexpected model outputs: ${session.outputNames.join(", ")}`,
    );
  }

  const embedOne = async (text: string): Promise<Float32Array<ArrayBuffer>> => {
    const ids = toModelInputIds(tokenizer, text, config.maxTokens);
    const shape = [1, ids.length];
    const feeds: Record<string, Tensor> = {};
    for (const name of session.inputNames) {
      if (name === "input_ids") {
        feeds[name] = new Tensor(
          "int64",
          BigInt64Array.from(ids, BigInt),
          shape,
        );
      } else if (name === "attention_mask") {
        feeds[name] = new Tensor(
          "int64",
          new BigInt64Array(ids.length).fill(1n),
          shape,
        );
      } else if (name === "position_ids") {
        feeds[name] = new Tensor(
          "int64",
          BigInt64Array.from(ids, (_, index) => BigInt(index)),
          shape,
        );
      } else if (MEDIA_FEATURE_INPUTS.has(name)) {
        feeds[name] = new Tensor("float32", new Float32Array(0), [
          0,
          MEDIA_FEATURE_WIDTH,
        ]);
      } else {
        throw new Error(`Unexpected model input: ${name}`);
      }
    }

    const output = (await session.run(feeds, [outputName]))[outputName];
    const data = output.data as Float32Array;
    const width = Number(output.dims.at(-1));
    if (width !== EMBEDDING_DIMENSIONS) {
      throw new Error(`Unexpected embedding width: ${width}`);
    }
    return l2Normalize(
      outputName === "sentence_embedding"
        ? data.slice(0, width)
        : meanPool(data, ids.length, width),
    );
  };

  return {
    async embed(texts) {
      const vectors: Float32Array<ArrayBuffer>[] = [];
      for (const text of texts) {
        vectors.push(await embedOne(text));
      }
      return vectors;
    },
    countTokens: (texts) =>
      texts.map((text) => tokenizer.encode(text).length + 2),
    release: () => session.release(),
  };
}
