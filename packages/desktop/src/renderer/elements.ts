import type { ElementDefinition } from "cytoscape";
import type { GraphIndex } from "@bando/core/query";
import type { CodeNode } from "@bando/core/types";
import { ROOT, type FolderTree } from "@bando/core/folder-tree";
import { folderOf } from "@bando/core/targets";

/** Beyond this many nodes per column the call graph becomes unreadable, so it gets cut. */
const MAX_PER_LEVEL = 40;
const COLUMN_WIDTH = 320;
const ROW_HEIGHT = 70;

export function isSymbol(node: CodeNode): boolean {
  return node.kind !== "file" && node.kind !== "package";
}

/** "src/a.ts#Class.method" → "Class.method"; files and packages keep their id. */
export function symbolName(node: CodeNode): string {
  return isSymbol(node) ? node.id.slice(node.id.indexOf("#") + 1) : node.name;
}

/**
 * The dependency view at the current level of detail: open folders are boxes containing their
 * contents, closed folders are single nodes, and imports are summed up between whatever is visible.
 */
export function dependencyElements(
  index: GraphIndex,
  tree: FolderTree,
  expanded: ReadonlySet<string>,
  includePackages: boolean,
): ElementDefinition[] {
  const elements: ElementDefinition[] = [];
  const boxOf = (folder: string | undefined) => (folder && folder !== ROOT ? `dir:${folder}` : undefined);

  for (const folder of tree.folders.values()) {
    if (folder.path === ROOT) continue;
    // Only folders whose parent is open are visible, as a box (open) or a node (closed).
    if (!expanded.has(folder.parent!)) continue;
    const open = expanded.has(folder.path);
    elements.push({
      data: open
        ? { id: `dir:${folder.path}`, label: `${folder.name}/`, kind: "dir", parent: boxOf(folder.parent) }
        : {
            id: `dir:${folder.path}`,
            label: `${folder.name}/\n${folder.totalFiles} archivos`,
            kind: "folder",
            size: folder.totalFiles,
            parent: boxOf(folder.parent),
          },
    });
  }
  for (const node of index.graph.nodes) {
    if (node.kind === "file") {
      const folder = folderOf(node.id);
      if (!expanded.has(folder)) continue;
      const importers = index.incoming(node.id, "imports").length;
      elements.push({ data: { id: node.id, label: node.name, kind: "file", weight: importers, parent: boxOf(folder) } });
    } else if (node.kind === "package" && includePackages) {
      const importers = index.incoming(node.id, "imports").length;
      elements.push({ data: { id: node.id, label: node.name, kind: "package", weight: importers } });
    }
  }

  // Imports between whatever represents each end at this level of detail.
  const visible = (id: string) => (id.startsWith("pkg:") ? id : tree.representative(id, expanded));
  const nodeId = (rep: string) => (rep.startsWith("pkg:") || index.node(rep)?.kind === "file" ? rep : `dir:${rep}`);
  const counts = new Map<string, number>();
  for (const edge of index.graph.edges) {
    if (edge.kind !== "imports" || (edge.to.startsWith("pkg:") && !includePackages)) continue;
    const from = nodeId(visible(edge.from));
    const to = nodeId(visible(edge.to));
    if (from !== to) counts.set(`${from}\u0000${to}`, (counts.get(`${from}\u0000${to}`) ?? 0) + 1);
  }
  for (const [key, count] of counts) {
    const [source, target] = key.split("\u0000");
    const aggregated = source!.startsWith("dir:") || target!.startsWith("dir:");
    elements.push({
      data: { id: `${source}->${target}`, source, target, count, label: aggregated && count > 1 ? String(count) : "" },
    });
  }
  return elements;
}

export interface CallGraph {
  elements: ElementDefinition[];
  truncated: boolean;
}

/**
 * Callers to the left, callees to the right, `depth` levels each way.
 * Positions are computed here (preset layout) so the reading direction is always the same.
 */
export function callElements(index: GraphIndex, focusId: string, depth: number): CallGraph {
  const level = new Map<string, number>([[focusId, 0]]);
  let truncated = false;

  for (const direction of [1, -1] as const) {
    let frontier = [focusId];
    for (let d = 1; d <= depth && frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        const edges = direction === 1 ? index.outgoing(id, "calls") : index.incoming(id, "calls");
        for (const edge of edges) {
          const other = direction === 1 ? edge.to : edge.from;
          if (level.has(other)) continue;
          if (next.length >= MAX_PER_LEVEL) {
            truncated = true;
            continue;
          }
          level.set(other, d * direction);
          next.push(other);
        }
      }
      frontier = next;
    }
  }

  const columns = new Map<number, CodeNode[]>();
  for (const [id, lvl] of level) {
    const node = index.node(id);
    if (!node) continue;
    const column = columns.get(lvl) ?? [];
    column.push(node);
    columns.set(lvl, column);
  }

  const elements: ElementDefinition[] = [];
  for (const [lvl, nodes] of columns) {
    nodes.sort((a, b) => symbolName(a).localeCompare(symbolName(b)));
    nodes.forEach((node, i) => {
      elements.push({
        data: {
          id: node.id,
          label: `${symbolName(node)}\n${node.file}`,
          kind: node.kind,
          focus: lvl === 0,
        },
        position: { x: lvl * COLUMN_WIDTH, y: (i - (nodes.length - 1) / 2) * ROW_HEIGHT },
      });
    });
  }

  for (const id of level.keys()) {
    for (const edge of index.outgoing(id, "calls")) {
      if (level.has(edge.to)) {
        elements.push({ data: { id: `${edge.from}->${edge.to}`, source: edge.from, target: edge.to, count: edge.count } });
      }
    }
  }
  return { elements, truncated };
}
