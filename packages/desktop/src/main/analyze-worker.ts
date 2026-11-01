import { parentPort, workerData } from "node:worker_threads";
import { analyzeProject } from "@bando/core";

const graph = analyzeProject(workerData.root as string, {
  onProgress: (message) => parentPort!.postMessage({ type: "progress", message }),
});
parentPort!.postMessage({ type: "done", graph });
