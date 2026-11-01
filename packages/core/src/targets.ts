import type { CodeGraph } from "./types.js";

/** What a summary is about. Has no Node.js dependencies, so the UI can use it too. */
export type SummaryTarget = { kind: "file"; id: string } | { kind: "folder"; id: string } | { kind: "project" };

/** "file:src/a.ts", "folder:src" or "project": identifies a summary in caches and events. */
export function summaryKey(target: SummaryTarget): string {
  return target.kind === "project" ? "project" : `${target.kind}:${target.id}`;
}

/** "src/a/b.ts" → "src/a"; files at the root belong to ".". */
export function folderOf(fileId: string): string {
  return fileId.includes("/") ? fileId.slice(0, fileId.lastIndexOf("/")) : ".";
}

/** Folders that directly contain at least one analyzed file, sorted by path. */
export function listFolders(graph: CodeGraph): string[] {
  return [...new Set(graph.nodes.filter((n) => n.kind === "file").map((n) => folderOf(n.id)))].sort();
}
