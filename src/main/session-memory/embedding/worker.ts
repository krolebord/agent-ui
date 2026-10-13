import { readdirSync } from "node:fs";
import os from "node:os";
import { formatDocumentPrompt, formatQueryPrompt } from "./embedder";
import {
  type EmbeddingWorkerRequest,
  type EmbeddingWorkerResponse,
  embeddingWorkerConfigSchema,
  embeddingWorkerRequestSchema,
} from "./ipc";
import { type EmbeddingRuntime, loadEmbeddingRuntime } from "./runtime";

// Linux applies nice per thread; threads started later inherit it.
function lowerPriority() {
  const priority = os.constants.priority.PRIORITY_LOW;
  try {
    os.setPriority(priority);
  } catch {}
  if (process.platform !== "linux") return;
  try {
    for (const tid of readdirSync("/proc/self/task")) {
      try {
        os.setPriority(Number(tid), priority);
      } catch {}
    }
  } catch {}
}

function send(response: EmbeddingWorkerResponse) {
  process.send?.(response);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

lowerPriority();

const config = embeddingWorkerConfigSchema.parse(
  JSON.parse(process.argv[2] ?? "null"),
);
let runtime: Promise<EmbeddingRuntime> | null = null;

function getRuntime(): Promise<EmbeddingRuntime> {
  runtime ??= loadEmbeddingRuntime(config).catch((error) => {
    runtime = null;
    throw error;
  });
  return runtime;
}

async function handle(
  request: EmbeddingWorkerRequest,
): Promise<EmbeddingWorkerResponse> {
  const loaded = await getRuntime();
  switch (request.type) {
    case "embedDocuments":
      return {
        id: request.id,
        type: "vectors",
        vectors: await loaded.embed(
          request.documents.map(formatDocumentPrompt),
        ),
      };
    case "embedQueries":
      return {
        id: request.id,
        type: "vectors",
        vectors: await loaded.embed(request.queries.map(formatQueryPrompt)),
      };
    case "countTokens":
      return {
        id: request.id,
        type: "tokenCounts",
        counts: loaded.countTokens(request.texts),
      };
    default: {
      const exhaustive: never = request;
      throw new Error(`Unhandled request: ${JSON.stringify(exhaustive)}`);
    }
  }
}

let queue = Promise.resolve();

process.on("message", (message: unknown) => {
  const parsed = embeddingWorkerRequestSchema.safeParse(message);
  if (!parsed.success) {
    const id = (message as { id?: unknown } | null)?.id;
    send({
      id: typeof id === "number" ? id : null,
      type: "error",
      message: `Invalid embedding worker request: ${parsed.error.message}`,
    });
    return;
  }
  queue = queue.then(async () => {
    try {
      send(await handle(parsed.data));
    } catch (error) {
      send({ id: parsed.data.id, type: "error", message: errorMessage(error) });
    }
  });
});

process.on("disconnect", () => {
  process.exit(0);
});
