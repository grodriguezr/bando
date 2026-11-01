import type { ElementDefinition } from "cytoscape";
import type { GraphIndex } from "@bando/core/query";
import type { CodeNode } from "@bando/core/types";

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

/** File → file imports, with files grouped into one box per directory. */
export function dependencyElements(index: GraphIndex, includePackages: boolean): ElementDefinition[] {
  const elements: ElementDefinition[] = [];
  const dirs = new Set<string>();

  for (const node of index.graph.nodes) {
    const importers = index.incoming(node.id, "imports").length;
    if (node.kind === "file") {
      const dir = node.id.includes("/") ? node.id.slice(0, node.id.lastIndexOf("/")) : "";
      if (dir) dirs.add(dir);
      elements.push({
        data: { id: node.id, label: node.name, kind: "file", weight: importers, parent: dir ? `dir:${dir}` : undefined },
      });
    } else if (node.kind === "package" && includePackages) {
      elements.push({ data: { id: node.id, label: node.name, kind: "package", weight: importers } });
    }
  }
  for (const dir of dirs) elements.push({ data: { id: `dir:${dir}`, label: dir, kind: "dir" } });

  const present = new Set(elements.map((e) => e.data.id));
  for (const edge of index.graph.edges) {
    if (edge.kind === "imports" && present.has(edge.from) && present.has(edge.to)) {
      elements.push({ data: { id: `${edge.from}->${edge.to}`, source: edge.from, target: edge.to, count: edge.count } });
    }
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
