import { parentPort, workerData } from "node:worker_threads";
import { analyze } from "@bando/core";

const graph = await analyze(workerData.root as string, {
  onProgress: (message) => parentPort!.postMessage({ type: "progress", message }),
});
parentPort!.postMessage({ type: "done", graph });
