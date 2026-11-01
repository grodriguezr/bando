import type { CodeEdge, CodeGraph, CodeNode, EdgeKind } from "./types.js";

/** In-memory index over a CodeGraph for navigation queries. Has no dependency on the TypeScript compiler. */
export class GraphIndex {
  private readonly byId = new Map<string, CodeNode>();
  private readonly out = new Map<string, CodeEdge[]>();
  private readonly in = new Map<string, CodeEdge[]>();

  constructor(readonly graph: CodeGraph) {
    for (const node of graph.nodes) this.byId.set(node.id, node);
    for (const edge of graph.edges) {
      push(this.out, edge.from, edge);
      push(this.in, edge.to, edge);
    }
  }

  node(id: string): CodeNode | undefined {
    return this.byId.get(id);
  }

  outgoing(id: string, kind?: EdgeKind): CodeEdge[] {
    return (this.out.get(id) ?? []).filter((e) => !kind || e.kind === kind);
  }

  incoming(id: string, kind?: EdgeKind): CodeEdge[] {
    return (this.in.get(id) ?? []).filter((e) => !kind || e.kind === kind);
  }

  children(id: string): CodeNode[] {
    return this.outgoing(id, "contains").map((e) => this.byId.get(e.to)!);
  }

  callers(id: string): CodeNode[] {
    return this.incoming(id, "calls").map((e) => this.byId.get(e.from)!);
  }

  callees(id: string): CodeNode[] {
    return this.outgoing(id, "calls").map((e) => this.byId.get(e.to)!);
  }

  /** Nodes whose name or id matches `query` (case-insensitive substring), exact name matches first. */
  search(query: string, limit = 50): CodeNode[] {
    const q = query.toLowerCase();
    return this.graph.nodes
      .filter((n) => n.id.toLowerCase().includes(q))
      .sort((a, b) => Number(b.name.toLowerCase() === q) - Number(a.name.toLowerCase() === q))
      .slice(0, limit);
  }

  /** Symbols with the most distinct callers: usually the core of the codebase. */
  mostCalled(limit = 10): { node: CodeNode; callers: number }[] {
    return this.graph.nodes
      .filter((n) => n.kind !== "file" && n.kind !== "package")
      .map((node) => ({ node, callers: this.incoming(node.id, "calls").length }))
      .filter((x) => x.callers > 0)
      .sort((a, b) => b.callers - a.callers)
      .slice(0, limit);
  }

  /** Exported symbols nobody inside the project calls: public API or entry points. */
  entryPoints(): CodeNode[] {
    return this.graph.nodes.filter(
      (n) => (n.kind === "function" || n.kind === "class") && n.exported && this.incoming(n.id, "calls").length === 0,
    );
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
