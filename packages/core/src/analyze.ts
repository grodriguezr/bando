import fs from "node:fs";
import path from "node:path";
import { analyzeProject, hasJavaScriptSources, type AnalyzeOptions } from "./analyzer.js";
import { analyzePython, findPythonFiles } from "./python.js";
import type { CodeGraph } from "./types.js";

/**
 * Analyzes a project in every language Bando understands (JavaScript/TypeScript and Python) and
 * merges the results into one graph, so mixed repositories show up as a whole.
 */
export async function analyze(rootDir: string, options: AnalyzeOptions = {}): Promise<CodeGraph> {
  const started = Date.now();
  const root = path.resolve(rootDir);
  if (!fs.statSync(root).isDirectory()) throw new Error(`${root} no es una carpeta`);
  const log = options.onProgress ?? (() => {});

  const pythonFiles = findPythonFiles(root);
  const withJs = options.tsconfig !== undefined || hasJavaScriptSources(root) || pythonFiles.length === 0;
  const graph: CodeGraph = withJs
    ? analyzeProject(root, options)
    : {
        root,
        generatedAt: new Date().toISOString(),
        nodes: [],
        edges: [],
        stats: {
          files: 0,
          symbols: 0,
          edges: 0,
          resolvedCalls: 0,
          externalCalls: 0,
          unresolvedCalls: 0,
          durationMs: 0,
        },
      };
  const languages = withJs && graph.stats.files > 0 ? ["javascript/typescript"] : [];

  if (pythonFiles.length) {
    log(`${pythonFiles.length} archivos Python`);
    const python = await analyzePython(root, pythonFiles);
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const node of python.nodes) if (!nodes.has(node.id)) nodes.set(node.id, node);
    graph.nodes = [...nodes.values()];
    graph.edges = [...graph.edges, ...python.edges];
    graph.stats.files += python.files;
    graph.stats.resolvedCalls += python.callStats.resolvedCalls;
    graph.stats.externalCalls += python.callStats.externalCalls;
    graph.stats.unresolvedCalls += python.callStats.unresolvedCalls;
    languages.push("python");
  }

  graph.stats.symbols = graph.nodes.filter((n) => n.kind !== "file" && n.kind !== "package").length;
  graph.stats.edges = graph.edges.length;
  graph.stats.durationMs = Date.now() - started;
  graph.languages = languages;
  return graph;
}
