export const EMBEDDING_DIMENSIONS = 768;
export const DEFAULT_EMBEDDING_MAX_TOKENS = 1024;
export const DEFAULT_EMBEDDING_THREADS = 2;

export interface EmbeddingDocument {
  title: string | null;
  text: string;
}

export interface Embedder {
  embedDocuments(documents: EmbeddingDocument[]): Promise<Float32Array[]>;
  embedQuery(query: string): Promise<Float32Array>;
  /** Untruncated token counts of the raw texts, including BOS and EOS. */
  countTokens(texts: string[]): Promise<number[]>;
  dispose(): Promise<void>;
}

export function formatDocumentPrompt(document: EmbeddingDocument): string {
  return `title: ${document.title || "none"} | text: ${document.text}`;
}

export function formatQueryPrompt(query: string): string {
  return `task: search result | query: ${query}`;
}
