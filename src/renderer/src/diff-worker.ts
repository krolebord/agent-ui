import WorkerUrl from "@pierre/diffs/worker/worker.js?worker&url";

export function diffsWorkerFactory(): Worker {
  return new Worker(WorkerUrl, { type: "module" });
}
