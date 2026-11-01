export type NodeKind = "file" | "class" | "interface" | "function" | "method" | "package";

export type EdgeKind =
  | "contains" // file → class/function, class → method
  | "imports" // file → file | package
  | "calls" // function/method/file → function/method/class
  | "extends" // class → class, interface → interface
  | "implements"; // class → interface

export interface CodeNode {
  /** Unique id: "src/a.ts" for files, "src/a.ts#Class.method" for symbols, "pkg:react" for packages. */
  id: string;
  kind: NodeKind;
  name: string;
  /** Path relative to the analyzed root. Empty for packages. */
  file: string;
  /** 1-based line range. 0 for packages. */
  line: number;
  endLine: number;
  exported: boolean;
  signature?: string;
  doc?: string;
}

export interface CodeEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** How many times the relation appears (e.g. a function calling another 3 times). */
  count: number;
  /** Lines in `from`'s file where the relation appears. */
  lines: number[];
}

export interface GraphStats {
  files: number;
  symbols: number;
  edges: number;
  /** Calls resolved to a function, method or class of the project. */
  resolvedCalls: number;
  /** Calls into node_modules or the standard library. */
  externalCalls: number;
  /** Calls whose target could not be determined statically (dynamic dispatch, callbacks, any). */
  unresolvedCalls: number;
  durationMs: number;
}

export interface CodeGraph {
  root: string;
  generatedAt: string;
  tsconfig?: string;
  nodes: CodeNode[];
  edges: CodeEdge[];
  stats: GraphStats;
}
