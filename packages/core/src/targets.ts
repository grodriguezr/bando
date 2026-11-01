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

const SOURCE_FILE = /\.(m?[jt]sx?|c[jt]s)$/;

/** True for strings that look like a JS/TS source file: "src/app.ts", "main.tsx"… */
export function looksLikeSourceFile(text: string): boolean {
  return !/\s/.test(text) && SOURCE_FILE.test(text);
}

/**
 * Source files mentioned in `code spans` of a summary that don't exist in the graph:
 * paths a model invented. A bare file name counts as known if any file has that name.
 */
export function findUnknownReferences(graph: CodeGraph, text: string): string[] {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const names = new Set(graph.nodes.filter((n) => n.kind === "file").map((n) => n.name));
  const unknown = new Set<string>();
  for (const [, raw] of text.matchAll(/`([^`\n]+)`/g)) {
    const ref = raw!.trim().replace(/^\.\//, "");
    if (!looksLikeSourceFile(ref) || ids.has(ref)) continue;
    if (!ref.includes("/") && names.has(ref)) continue;
    unknown.add(ref);
  }
  return [...unknown];
}
