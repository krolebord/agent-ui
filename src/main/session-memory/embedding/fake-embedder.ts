import { createHash } from "node:crypto";
import {
  EMBEDDING_DIMENSIONS,
  type Embedder,
  type EmbeddingDocument,
} from "./embedder";

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

/** Hashed bag of words: texts sharing words get higher cosine similarity. */
export function fakeEmbedding(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIMENSIONS);
  for (const word of words(text)) {
    const digest = createHash("sha256").update(word).digest();
    const index = digest.readUInt32LE(0) % EMBEDDING_DIMENSIONS;
    vector[index] += digest[4] & 1 ? 1 : -1;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  norm = Math.sqrt(norm);
  for (let index = 0; index < vector.length; index++) vector[index] /= norm;
  return vector;
}

export class FakeEmbedder implements Embedder {
  readonly calls: Array<
    | { type: "embedDocuments"; documents: EmbeddingDocument[] }
    | { type: "embedQuery"; query: string }
    | { type: "countTokens"; texts: string[] }
  > = [];
  disposed = false;

  async embedDocuments(
    documents: EmbeddingDocument[],
  ): Promise<Float32Array[]> {
    this.assertActive();
    this.calls.push({ type: "embedDocuments", documents });
    return documents.map((document) =>
      fakeEmbedding(`${document.title ?? ""} ${document.text}`),
    );
  }

  async embedQuery(query: string): Promise<Float32Array> {
    this.assertActive();
    this.calls.push({ type: "embedQuery", query });
    return fakeEmbedding(query);
  }

  async countTokens(texts: string[]): Promise<number[]> {
    this.assertActive();
    this.calls.push({ type: "countTokens", texts });
    return texts.map((text) => words(text).length + 2);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }

  private assertActive() {
    if (this.disposed) {
      throw new Error("Embedder is disposed");
    }
  }
}
