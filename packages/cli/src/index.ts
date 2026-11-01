#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { analyzeProject, GraphIndex, type CodeGraph, type CodeNode } from "@bando/core";
import { describeSummaryError, summarizeModule, type SummaryProvider } from "@bando/core/summarize";

const USAGE = `Uso:
  bando analyze <directorio> [-o graph.json] [--tsconfig ruta]   Analiza un proyecto y guarda el grafo
  bando inspect <símbolo> [-g graph.json]                        Muestra quién llama a un símbolo y a quién llama
  bando mermaid [-g graph.json] [--packages]                     Diagrama Mermaid de dependencias entre archivos
  bando summarize <archivo> [-g graph.json]                      Resume un módulo con Claude (requiere ANTHROPIC_API_KEY)
    --local [--url http://localhost:1234/v1] [--model id]        …o con un modelo local (LM Studio, Ollama, llama.cpp)`;

const DEFAULT_GRAPH = "graph.json";

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o", default: DEFAULT_GRAPH },
      graph: { type: "string", short: "g", default: DEFAULT_GRAPH },
      tsconfig: { type: "string" },
      packages: { type: "boolean", default: false },
      local: { type: "boolean", default: false },
      url: { type: "string" },
      model: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, arg] = positionals;

  if (values.help || !command) return console.log(USAGE);
  if (command === "analyze") return analyze(arg ?? ".", values.output, values.tsconfig);
  if (command === "inspect" && arg) return inspect(loadGraph(values.graph), arg);
  if (command === "mermaid") return console.log(mermaid(loadGraph(values.graph), values.packages));
  if (command === "summarize" && arg) return summarize(loadGraph(values.graph), arg, values.local ? { kind: "local", baseUrl: values.url, model: values.model } : undefined);

  console.error(USAGE);
  process.exitCode = 1;
}

function analyze(dir: string, output: string, tsconfig?: string): void {
  const graph = analyzeProject(dir, { tsconfig, onProgress: (m) => console.error(`· ${m}`) });
  fs.writeFileSync(output, JSON.stringify(graph, null, 2));

  const index = new GraphIndex(graph);
  const { stats } = graph;
  const totalCalls = stats.resolvedCalls + stats.externalCalls + stats.unresolvedCalls;
  const pct = (n: number) => (totalCalls ? `${Math.round((n / totalCalls) * 100)}%` : "0%");

  console.log(`\nProyecto: ${graph.root}`);
  console.log(`  ${stats.files} archivos, ${stats.symbols} símbolos, ${stats.edges} relaciones (${stats.durationMs} ms)`);
  console.log(
    `  Llamadas: ${stats.resolvedCalls} internas (${pct(stats.resolvedCalls)}), ` +
      `${stats.externalCalls} a librerías (${pct(stats.externalCalls)}), ` +
      `${stats.unresolvedCalls} sin resolver (${pct(stats.unresolvedCalls)})`,
  );

  const kinds = countBy(graph.nodes, (n) => n.kind);
  console.log(`  Tipos: ${Object.entries(kinds).map(([k, v]) => `${v} ${k}`).join(", ")}`);

  const packages = graph.nodes
    .filter((n) => n.kind === "package")
    .map((n) => ({ name: n.name, users: index.incoming(n.id, "imports").length }))
    .sort((a, b) => b.users - a.users)
    .slice(0, 10);
  if (packages.length) {
    console.log(`\nDependencias más usadas:`);
    for (const p of packages) console.log(`  ${p.name.padEnd(30)} ${p.users} archivos`);
  }

  const mostCalled = index.mostCalled(10);
  if (mostCalled.length) {
    console.log(`\nSímbolos más llamados (el núcleo del proyecto):`);
    for (const { node, callers } of mostCalled) console.log(`  ${label(node).padEnd(50)} ${callers} llamadores`);
  }

  const hubs = graph.nodes
    .filter((n) => n.kind === "file")
    .map((node) => ({ node, importers: index.incoming(node.id, "imports").length }))
    .filter((x) => x.importers > 0)
    .sort((a, b) => b.importers - a.importers)
    .slice(0, 10);
  if (hubs.length) {
    console.log(`\nArchivos más importados:`);
    for (const { node, importers } of hubs) console.log(`  ${node.id.padEnd(50)} ${importers} archivos`);
  }

  console.log(`\nGrafo guardado en ${path.resolve(output)}`);
  console.log(`Siguiente paso: bando inspect <nombre> -g ${output}`);
}

function inspect(graph: CodeGraph, query: string): void {
  const index = new GraphIndex(graph);
  const matches = index.search(query).filter((n) => n.kind !== "package");
  if (!matches.length) {
    console.error(`No se encontró "${query}"`);
    process.exitCode = 1;
    return;
  }
  const exact = matches.filter((n) => n.name === query || n.id === query);
  const shown = exact.length ? exact : matches.slice(0, 1);

  for (const node of shown) {
    console.log(`\n${label(node)}  [${node.kind}${node.exported ? ", exportado" : ""}]`);
    console.log(`  ${node.file}:${node.line}-${node.endLine}`);
    if (node.signature) console.log(`  ${node.signature}`);
    if (node.doc) console.log(`  ${node.doc.split("\n").join("\n  ")}`);

    const section = (title: string, rows: string[]) => {
      if (!rows.length) return;
      console.log(`\n  ${title} (${rows.length}):`);
      for (const row of rows) console.log(`    ${row}`);
    };
    section(
      "Lo llaman",
      index.incoming(node.id, "calls").map((e) => `${label(index.node(e.from)!)}  (${e.count}×, línea ${e.lines.join(", ")})`),
    );
    section(
      "Llama a",
      index.outgoing(node.id, "calls").map((e) => `${label(index.node(e.to)!)}  (${e.count}×)`),
    );
    section("Contiene", index.children(node.id).map((c) => `${c.kind.padEnd(9)} ${c.name}`));
    section("Importa", index.outgoing(node.id, "imports").map((e) => e.to.replace(/^pkg:/, "📦 ")));
    section("Importado por", index.incoming(node.id, "imports").map((e) => e.from));
    section("Hereda de", [...index.outgoing(node.id, "extends"), ...index.outgoing(node.id, "implements")].map((e) => `${e.kind} ${e.to}`));
    section("Subtipos", [...index.incoming(node.id, "extends"), ...index.incoming(node.id, "implements")].map((e) => e.from));
  }
  if (!exact.length && matches.length > 1) {
    console.log(`\nOtras coincidencias: ${matches.slice(1, 10).map((n) => n.id).join(", ")}`);
  }
}

async function summarize(graph: CodeGraph, file: string, provider?: SummaryProvider): Promise<void> {
  // Accept the graph id ("src/a.ts") or a path relative to the current directory.
  const fileId = graph.nodes.some((n) => n.id === file && n.kind === "file")
    ? file
    : path.relative(graph.root, path.resolve(file)).split(path.sep).join("/");
  try {
    const source = fs.readFileSync(path.join(graph.root, fileId), "utf8");
    console.error(`· Resumiendo ${fileId}…\n`);
    const started = Date.now();
    const { model } = await summarizeModule(graph, fileId, source, {
      provider,
      onText: (text) => process.stdout.write(text),
    });
    console.error(`\n\n· Generado con ${model} en ${((Date.now() - started) / 1000).toFixed(1)} s`);
  } catch (error) {
    console.error(`\n${describeSummaryError(error)}`);
    process.exitCode = 1;
  }
}

function mermaid(graph: CodeGraph, includePackages: boolean): string {
  const ids = new Map<string, string>();
  const key = (id: string) => {
    if (!ids.has(id)) ids.set(id, `n${ids.size}`);
    return ids.get(id)!;
  };
  const lines = ["flowchart LR"];
  const keep = (id: string) => includePackages || !id.startsWith("pkg:");

  for (const node of graph.nodes) {
    if (node.kind === "file" || (includePackages && node.kind === "package")) {
      const text = node.kind === "package" ? `📦 ${node.name}` : node.id;
      lines.push(`  ${key(node.id)}["${text.replace(/"/g, "'")}"]`);
    }
  }
  for (const edge of graph.edges) {
    if (edge.kind === "imports" && keep(edge.to)) lines.push(`  ${key(edge.from)} --> ${key(edge.to)}`);
  }
  return lines.join("\n");
}

function loadGraph(file: string): CodeGraph {
  if (!fs.existsSync(file)) {
    console.error(`No existe ${file}. Ejecuta primero: bando analyze <directorio> -o ${file}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as CodeGraph;
}

function label(node: CodeNode): string {
  if (node.kind === "file" || node.kind === "package") return node.id;
  const [file, symbol] = node.id.split("#");
  return `${symbol}  (${file})`;
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

await main(process.argv.slice(2));
