#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { analyzeProject, GraphIndex, type CodeGraph, type CodeNode } from "@bando/core";
import { exportDocs } from "@bando/core/docs";
import { defaultConcurrency, SummaryStore } from "@bando/core/summary-store";
import {
  describeSummaryError,
  findUnknownReferences,
  listFolders,
  summarize as summarizeWithAi,
  type SummaryProvider,
  type SummaryTarget,
} from "@bando/core/summarize";

const USAGE = `Uso:
  bando analyze <directorio> [-o graph.json] [--tsconfig ruta]   Analiza un proyecto y guarda el grafo
  bando inspect <símbolo> [-g graph.json]                        Muestra quién llama a un símbolo y a quién llama
  bando mermaid [-g graph.json] [--packages]                     Diagrama Mermaid de dependencias entre archivos
  bando summarize <archivo|carpeta> [-g graph.json]              Resume un archivo o carpeta con Claude (requiere ANTHROPIC_API_KEY)
  bando guide [-g graph.json]                                    Guía "por dónde empezar" para todo el proyecto
  bando explain <función> [-g graph.json]                        Explica paso a paso qué ocurre cuando se ejecuta una función
  bando summarize-all [-g graph.json] [-j N]                     Resume archivos, carpetas y la guía (retoma si se interrumpe)
  bando docs [-o docs] [-g graph.json]                           Exporta la documentación en Markdown con los resúmenes guardados
    --local [--url http://localhost:1234/v1] [--model id]        Usa un modelo local (LM Studio, Ollama…) en lugar de Claude
  Los resúmenes se guardan en una caché compartida con la app de escritorio.`;

const DEFAULT_GRAPH = "graph.json";

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      graph: { type: "string", short: "g", default: DEFAULT_GRAPH },
      tsconfig: { type: "string" },
      packages: { type: "boolean", default: false },
      local: { type: "boolean", default: false },
      jobs: { type: "string", short: "j" },
      url: { type: "string" },
      model: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, arg] = positionals;

  if (values.help || !command) return console.log(USAGE);
  if (command === "analyze") return analyze(arg ?? ".", values.output ?? DEFAULT_GRAPH, values.tsconfig);
  if (command === "inspect" && arg) return inspect(loadGraph(values.graph), arg);
  if (command === "mermaid") return console.log(mermaid(loadGraph(values.graph), values.packages));
  const provider: SummaryProvider = values.local
    ? { kind: "local", baseUrl: values.url, model: values.model }
    : { kind: "anthropic" };
  if (command === "summarize" && arg) {
    const graph = loadGraph(values.graph);
    return summarize(graph, resolveTarget(graph, arg), provider);
  }
  if (command === "guide") return summarize(loadGraph(values.graph), { kind: "project" }, provider);
  if (command === "explain" && arg) {
    const graph = loadGraph(values.graph);
    const node = findSymbol(graph, arg);
    if (!node) {
      console.error(`No se encontró la función "${arg}". Prueba con: bando inspect ${arg}`);
      process.exitCode = 1;
      return;
    }
    return summarize(graph, { kind: "flow", id: node.id }, provider);
  }
  if (command === "summarize-all") {
    const jobs = values.jobs ? Number(values.jobs) : defaultConcurrency(provider);
    return summarizeAll(loadGraph(values.graph), provider, jobs);
  }
  if (command === "docs") return docs(loadGraph(values.graph), values.graph, values.output ?? "docs", provider);

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

async function summarize(graph: CodeGraph, target: SummaryTarget, provider: SummaryProvider): Promise<void> {
  const label = target.kind === "project" ? "el proyecto" : target.kind === "flow" ? `el flujo de ${target.id}` : target.id;
  try {
    console.error(`· Resumiendo ${label}…\n`);
    const started = Date.now();
    const { text, model } = await new SummaryStore().generate(graph, target, {
      provider,
      onText: (delta) => process.stdout.write(delta),
    });
    console.error(`\n\n· Generado con ${model} en ${((Date.now() - started) / 1000).toFixed(1)} s`);
    warnUnknownReferences(graph, text);
  } catch (error) {
    console.error(`\n${describeSummaryError(error)}`);
    process.exitCode = 1;
  }
}

async function summarizeAll(graph: CodeGraph, provider: SummaryProvider, concurrency: number): Promise<void> {
  const started = Date.now();
  const label = (t: SummaryTarget) => (t.kind === "project" ? "guía del proyecto" : t.kind === "folder" ? `${t.id}/` : t.id);
  let stop = false;
  process.once("SIGINT", () => {
    stop = true;
    console.error("\n· Deteniendo al terminar el resumen actual (Ctrl+C otra vez para salir ya)…");
    process.once("SIGINT", () => process.exit(130));
  });
  console.error(`· ${concurrency} resúmenes a la vez`);
  await new SummaryStore().summarizeAll(graph, {
    provider,
    concurrency,
    shouldStop: () => stop,
    onEvent: (event) => {
      if (event.type === "start") {
        console.error(event.total ? `· ${event.total} resúmenes pendientes` : "· Todo está al día.");
      } else if (event.type === "progress") {
        const elapsed = Date.now() - started;
        const eta = event.done ? ` · ~${Math.round(((elapsed / event.done) * (event.total - event.done)) / 60_000)} min restantes` : "";
        console.error(`[${event.done + 1}/${event.total}] ${label(event.target)}${eta}`);
      } else if (event.type === "summarized" && event.error) {
        console.error(`  ✖ ${event.error}`);
      } else if (event.type === "finished" && event.total > 0) {
        const minutes = ((Date.now() - started) / 60_000).toFixed(1);
        console.error(
          `· ${event.stopped ? "Detenido" : "Listo"}: ${event.done - event.failed} de ${event.total} resumidos` +
            `${event.failed ? `, ${event.failed} con error` : ""} en ${minutes} min.`,
        );
        if (event.failed) process.exitCode = 1;
      }
    },
  });
}

function docs(graph: CodeGraph, graphFile: string, outDir: string, provider: SummaryProvider): void {
  const summaries = new SummaryStore().known(graph.root, provider.kind);
  const result = exportDocs(graph, { outDir, summaries });
  const { summarized: s } = result;
  console.log(`Documentación escrita en ${result.outDir} (${result.pages} páginas).`);
  console.log(
    `  Con resumen de IA: ${s.files}/${s.totalFiles} archivos, ${s.folders}/${s.totalFolders} carpetas, ` +
      `guía: ${s.guide ? "sí" : "no"}.`,
  );
  if (s.files < s.totalFiles || s.folders < s.totalFolders || !s.guide) {
    const local = provider.kind === "local" ? " --local" : "";
    console.log(`  Para completarla: bando summarize-all -g ${graphFile}${local} y vuelve a exportar.`);
  }
  console.log(`  Ábrela en: ${path.join(result.outDir, "README.md")}`);
}

function warnUnknownReferences(graph: CodeGraph, text: string): void {
  const unknown = findUnknownReferences(graph, text);
  if (unknown.length) console.error(`⚠ Menciona archivos que no existen en el proyecto: ${unknown.join(", ")}`);
}

/** A function or method by id ("src/a.ts#f"), qualified name ("Clase.metodo") or unique name. */
function findSymbol(graph: CodeGraph, query: string): CodeNode | undefined {
  const callable = graph.nodes.filter((n) => n.kind === "function" || n.kind === "method");
  const byId = callable.find((n) => n.id === query);
  if (byId) return byId;
  const qualified = callable.filter((n) => n.id.endsWith(`#${query}`));
  if (qualified.length === 1) return qualified[0];
  const byName = callable.filter((n) => n.name === query);
  if (qualified.length > 1 || byName.length > 1) {
    const options = (qualified.length > 1 ? qualified : byName).map((n) => n.id);
    console.error(`"${query}" es ambiguo; usa uno de: ${options.slice(0, 8).join(", ")}`);
    return undefined;
  }
  return byName[0];
}

/** Accepts a graph id ("src/a.ts", "src/a") or a path relative to the current directory. */
function resolveTarget(graph: CodeGraph, arg: string): SummaryTarget {
  const id = (candidate: string) => candidate.replace(/\/$/, "") || ".";
  const relative = id(path.relative(graph.root, path.resolve(arg)).split(path.sep).join("/"));
  const folders = new Set(listFolders(graph));
  for (const candidate of [id(arg), relative]) {
    if (graph.nodes.some((n) => n.kind === "file" && n.id === candidate)) return { kind: "file", id: candidate };
    if (folders.has(candidate)) return { kind: "folder", id: candidate };
  }
  return { kind: "file", id: relative };
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
