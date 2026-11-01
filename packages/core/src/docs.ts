import fs from "node:fs";
import path from "node:path";
import { GraphIndex } from "./query.js";
import { findUnknownReferences, folderOf, listFolders } from "./targets.js";
import type { CodeGraph, CodeNode } from "./types.js";

export interface ExportDocsOptions {
  /** Where to write the docs; created if needed. Existing Bando pages in it are overwritten. */
  outDir: string;
  /** Summaries keyed by `summaryKey` ("file:<id>", "folder:<dir>", "project"). Missing ones are noted in the pages. */
  summaries: ReadonlyMap<string, string>;
}

export interface ExportDocsResult {
  outDir: string;
  pages: number;
  /** How many of the files, folders and the guide had an AI summary. */
  summarized: { files: number; totalFiles: number; folders: number; totalFolders: number; guide: boolean };
}

/** Folders shown in the project-level dependency diagram; bigger graphs stop being readable. */
const MAX_DIAGRAM_FOLDERS = 60;

/**
 * Writes the project's documentation as Markdown: an index with the guide and the architecture,
 * a README per folder (GitHub shows it when browsing the folder) and a page per file.
 */
export function exportDocs(graph: CodeGraph, options: ExportDocsOptions): ExportDocsResult {
  const writer = new DocsWriter(graph, options);
  return writer.write();
}

class DocsWriter {
  private readonly index: GraphIndex;
  private readonly files: CodeNode[];
  private readonly folders: string[];
  private readonly outDir: string;
  private readonly uniqueNames: Map<string, string>;
  private pages = 0;

  constructor(
    private readonly graph: CodeGraph,
    private readonly options: ExportDocsOptions,
  ) {
    this.index = new GraphIndex(graph);
    this.files = graph.nodes.filter((n) => n.kind === "file").sort((a, b) => a.id.localeCompare(b.id));
    this.folders = listFolders(graph);
    this.outDir = path.resolve(options.outDir);
    this.uniqueNames = uniqueNames(graph);
  }

  write(): ExportDocsResult {
    this.writePage("README.md", this.indexPage());
    for (const dir of this.folders) this.writePage(folderPage(dir), this.folderPage(dir));
    for (const file of this.files) this.writePage(filePage(file.id), this.filePage(file));
    const s = this.options.summaries;
    return {
      outDir: this.outDir,
      pages: this.pages,
      summarized: {
        files: this.files.filter((f) => s.has(`file:${f.id}`)).length,
        totalFiles: this.files.length,
        folders: this.folders.filter((d) => s.has(`folder:${d}`)).length,
        totalFolders: this.folders.length,
        guide: s.has("project"),
      },
    };
  }

  // ── Pages ──────────────────────────────────────────────────────────────

  private indexPage(): string {
    const page = "README.md";
    const name = path.basename(this.graph.root);
    const { stats } = this.graph;
    const lines = [
      `# ${name}: documentación del código`,
      "",
      `> Generada por Bando el ${new Date().toISOString().slice(0, 10)} a partir del análisis estático del código` +
        " y de resúmenes escritos por IA. Los resúmenes pueden contener errores: verifica contra el código.",
      "",
      `${stats.files} archivos · ${stats.symbols} símbolos · ${this.folders.length} carpetas`,
      "",
      "## Guía para empezar",
      "",
      this.summarySection(page, "project", "Todavía no hay guía. Genérala con `bando guide` o desde la app."),
      "## Estructura",
      "",
      this.folderDiagram(),
      "",
      "| Carpeta | Archivos | Propósito |",
      "| --- | ---: | --- |",
      ...this.folders.map((dir) => {
        const count = this.files.filter((f) => folderOf(f.id) === dir).length;
        const purpose = firstSentence(purposeOf(this.options.summaries.get(`folder:${dir}`)));
        return `| [\`${dir}/\`](${rel(page, folderPage(dir))}) | ${count} | ${cell(purpose)} |`;
      }),
      "",
    ];

    const entries = this.index.entryPoints();
    if (entries.length) {
      lines.push(
        "## Puntos de entrada",
        "",
        "Símbolos exportados que nadie llama dentro del proyecto: API pública o arranque.",
        "",
        ...entries.slice(0, 40).map((n) => `- ${this.symbolLink(page, n)}`),
        "",
      );
    }
    const mostCalled = this.index.mostCalled(15);
    if (mostCalled.length) {
      lines.push(
        "## Lo más usado",
        "",
        "| Símbolo | Llamadores |",
        "| --- | ---: |",
        ...mostCalled.map(({ node, callers }) => `| ${this.symbolLink(page, node)} | ${callers} |`),
        "",
      );
    }
    const packages = this.graph.nodes
      .filter((n) => n.kind === "package")
      .map((n) => ({ name: n.name, users: this.index.incoming(n.id, "imports").length }))
      .sort((a, b) => b.users - a.users);
    if (packages.length) {
      lines.push(
        "## Dependencias externas",
        "",
        "| Paquete | Archivos que lo usan |",
        "| --- | ---: |",
        ...packages.map((p) => `| \`${p.name}\` | ${p.users} |`),
        "",
      );
    }
    return lines.join("\n");
  }

  private folderPage(dir: string): string {
    const page = folderPage(dir);
    const files = this.files.filter((f) => folderOf(f.id) === dir);
    const inFolder = new Set(files.map((f) => f.id));
    const uses = new Map<string, number>();
    const usedBy = new Map<string, number>();
    for (const edge of this.graph.edges) {
      if (edge.kind !== "imports" || edge.to.startsWith("pkg:")) continue;
      if (inFolder.has(edge.from) && !inFolder.has(edge.to)) bump(uses, folderOf(edge.to));
      if (!inFolder.has(edge.from) && inFolder.has(edge.to)) bump(usedBy, folderOf(edge.from));
    }

    const lines = [
      `# \`${dir === "." ? "(raíz)" : `${dir}/`}\``,
      "",
      `[Índice](${rel(page, "README.md")})`,
      "",
      "## Resumen",
      "",
      this.summarySection(page, `folder:${dir}`, "Todavía no hay resumen de esta carpeta."),
      "## Archivos",
      "",
      "| Archivo | Exporta | Propósito |",
      "| --- | --- | --- |",
      ...files.map((file) => {
        const exported = descendants(this.index, file.id)
          .filter((s) => s.exported && s.kind !== "method")
          .map((s) => `\`${symbolName(s)}\``);
        const purpose = firstSentence(purposeOf(this.options.summaries.get(`file:${file.id}`)));
        return `| [${file.name}](${rel(page, filePage(file.id))}) | ${cell(exported.join(", "))} | ${cell(purpose)} |`;
      }),
      "",
    ];

    const diagram = this.fileDiagram(files);
    if (diagram) lines.push("## Dependencias entre sus archivos", "", diagram, "");
    lines.push(...this.folderList(page, "Importa de", uses), ...this.folderList(page, "La importan", usedBy));
    return lines.join("\n");
  }

  private filePage(file: CodeNode): string {
    const page = filePage(file.id);
    const dir = folderOf(file.id);
    const source = this.sourceLink(page, file.id);
    const lines = [
      `# \`${file.id}\``,
      "",
      `[Índice](${rel(page, "README.md")}) › [\`${dir === "." ? "(raíz)" : `${dir}/`}\`](${rel(page, folderPage(dir))}) · [Ver código](${source})`,
      "",
      "## Resumen",
      "",
      this.summarySection(page, `file:${file.id}`, "Todavía no hay resumen de este archivo."),
    ];

    const symbols = descendants(this.index, file.id);
    if (symbols.length) {
      lines.push("## Símbolos", "");
      for (const symbol of symbols) {
        const flags = [symbol.kind, symbol.exported ? "exportado" : undefined].filter(Boolean).join(", ");
        lines.push(
          `<a id="${anchor(symbol)}"></a>`,
          "",
          `### \`${symbolName(symbol)}\``,
          "",
          `${flags} · [líneas ${symbol.line}–${symbol.endLine}](${source}#L${symbol.line}-L${symbol.endLine})`,
          "",
        );
        if (symbol.signature) lines.push("```ts", symbol.signature, "```", "");
        if (symbol.doc) lines.push(symbol.doc, "");
        const callers = this.index.incoming(symbol.id, "calls").map((e) => this.index.node(e.from)!);
        const callees = this.index.outgoing(symbol.id, "calls").map((e) => this.index.node(e.to)!);
        if (callers.length) lines.push(`**Lo llaman:** ${callers.map((n) => this.symbolLink(page, n)).join(", ")}`, "");
        if (callees.length) lines.push(`**Llama a:** ${callees.map((n) => this.symbolLink(page, n)).join(", ")}`, "");
      }
    }

    const imports = this.index.outgoing(file.id, "imports");
    const importers = this.index.incoming(file.id, "imports");
    if (imports.length || importers.length) lines.push("## Relaciones", "");
    if (imports.length) {
      lines.push(
        "**Importa:**",
        "",
        ...imports.map((e) => (e.to.startsWith("pkg:") ? `- \`${e.to.slice(4)}\` (paquete)` : `- ${this.fileLink(page, e.to)}`)),
        "",
      );
    }
    if (importers.length) lines.push("**Lo importan:**", "", ...importers.map((e) => `- ${this.fileLink(page, e.from)}`), "");
    return lines.join("\n");
  }

  // ── Pieces ─────────────────────────────────────────────────────────────

  /** The AI summary with headings demoted under the page's section, paths turned into links. */
  private summarySection(page: string, key: string, missing: string): string {
    const text = this.options.summaries.get(key);
    if (!text) return `_${missing}_\n`;
    // The page already has a title for this section: drop the model's own top-level title.
    const body = text
      .replace(/^\s*#\s[^\n]*\n/, "")
      .replace(/^(#{1,5})\s/gm, "#$1 ")
      .replace(/`([^`\n]+)`/g, (whole, code: string) => {
        const target = this.resolve(code);
        return target ? `[\`${code}\`](${rel(page, target)})` : whole;
      });
    const unknown = findUnknownReferences(this.graph, text);
    const warning = unknown.length
      ? `\n> ⚠️ Este resumen menciona archivos que no existen en el proyecto: ${unknown.map((u) => `\`${u}\``).join(", ")}.\n`
      : "";
    return `${body.trim()}\n${warning}\n`;
  }

  /** Doc page for a path, file name or symbol mentioned in a summary. */
  private resolve(code: string): string | undefined {
    const text = code.trim().replace(/\(\)$/, "");
    const id = text.replace(/^\.\//, "").replace(/\/$/, "") || ".";
    const node = this.index.node(id) ?? this.index.node(this.uniqueNames.get(text) ?? "");
    if (node?.kind === "file") return filePage(node.id);
    if (node && node.kind !== "package") return `${filePage(node.file)}#${anchor(node)}`;
    if (this.folders.includes(id)) return folderPage(id);
    return undefined;
  }

  private folderDiagram(): string {
    const counts = new Map(this.folders.map((d) => [d, this.files.filter((f) => folderOf(f.id) === d).length]));
    const shown = [...this.folders].sort((a, b) => counts.get(b)! - counts.get(a)!).slice(0, MAX_DIAGRAM_FOLDERS);
    const visible = new Set(shown);
    const deps = new Map<string, number>();
    for (const edge of this.graph.edges) {
      if (edge.kind !== "imports" || edge.to.startsWith("pkg:")) continue;
      const from = folderOf(edge.from);
      const to = folderOf(edge.to);
      if (from !== to && visible.has(from) && visible.has(to)) bump(deps, `${from}\u0000${to}`);
    }
    const ids = new Map(shown.map((d, i) => [d, `f${i}`]));
    const lines = ["```mermaid", "flowchart LR"];
    for (const dir of shown) lines.push(`  ${ids.get(dir)}["${mermaidText(dir === "." ? "(raíz)" : `${dir}/`)}"]`);
    for (const [key, n] of deps) {
      const [from, to] = key.split("\u0000");
      lines.push(`  ${ids.get(from!)} -->|${n}| ${ids.get(to!)}`);
    }
    // Mermaid can't link to relative pages reliably on every host, so the links live in the table below.
    lines.push("```");
    if (this.folders.length > shown.length) lines.push("", `_Se muestran las ${shown.length} carpetas más grandes._`);
    return lines.join("\n");
  }

  private fileDiagram(files: CodeNode[]): string | undefined {
    const inFolder = new Set(files.map((f) => f.id));
    const edges = this.graph.edges.filter((e) => e.kind === "imports" && inFolder.has(e.from) && inFolder.has(e.to));
    if (!edges.length) return undefined;
    const ids = new Map(files.map((f, i) => [f.id, `n${i}`]));
    return [
      "```mermaid",
      "flowchart LR",
      ...files.map((f) => `  ${ids.get(f.id)}["${mermaidText(f.name)}"]`),
      ...edges.map((e) => `  ${ids.get(e.from)} --> ${ids.get(e.to)}`),
      "```",
    ].join("\n");
  }

  private folderList(page: string, title: string, folders: Map<string, number>): string[] {
    if (!folders.size) return [];
    return [
      `## ${title}`,
      "",
      ...[...folders]
        .sort((a, b) => b[1] - a[1])
        .map(([dir, n]) => `- [\`${dir === "." ? "(raíz)" : `${dir}/`}\`](${rel(page, folderPage(dir))}) (${n} importaciones)`),
      "",
    ];
  }

  private fileLink(page: string, fileId: string): string {
    return `[\`${fileId}\`](${rel(page, filePage(fileId))})`;
  }

  private symbolLink(page: string, node: CodeNode): string {
    if (node.kind === "file") return this.fileLink(page, node.id);
    return `[\`${symbolName(node)}\`](${rel(page, filePage(node.file))}#${anchor(node)})`;
  }

  /** Relative link from a doc page to the source file, so it works in the repo and on GitHub. */
  private sourceLink(page: string, fileId: string): string {
    const from = path.dirname(path.join(this.outDir, page));
    return encodeURI(path.relative(from, path.join(this.graph.root, fileId)).split(path.sep).join("/"));
  }

  private writePage(page: string, content: string): void {
    const file = path.join(this.outDir, page);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content.endsWith("\n") ? content : `${content}\n`);
    this.pages++;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function filePage(fileId: string): string {
  return `code/${fileId}.md`;
}

function folderPage(dir: string): string {
  return dir === "." ? "code/README.md" : `code/${dir}/README.md`;
}

/** Relative link between two doc pages (paths relative to the docs root). */
function rel(fromPage: string, toPage: string): string {
  const [target, hash] = toPage.split("#");
  const relative = path.posix.relative(path.posix.dirname(fromPage), target!) || path.posix.basename(target!);
  return encodeURI(relative) + (hash ? `#${hash}` : "");
}

function anchor(node: CodeNode): string {
  return `sym-${symbolName(node).replace(/[^\w-]+/g, "-")}`;
}

function symbolName(node: CodeNode): string {
  return node.id.slice(node.id.indexOf("#") + 1);
}

function descendants(index: GraphIndex, id: string): CodeNode[] {
  return index.children(id).flatMap((child) => [child, ...descendants(index, child.id)]);
}

/** File basenames and symbol names that identify exactly one node. */
function uniqueNames(graph: CodeGraph): Map<string, string> {
  const byName = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.kind === "package") continue;
    const name = node.kind === "file" ? node.name : symbolName(node);
    byName.set(name, [...(byName.get(name) ?? []), node.id]);
  }
  return new Map([...byName].filter(([, ids]) => ids.length === 1).map(([name, [id]]) => [name, id!]));
}

function purposeOf(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  const section = /#+\s*Prop[oó]sito\s*\n+([\s\S]*?)(?=\n#+\s|$)/i.exec(summary)?.[1];
  return (section ?? summary.split(/\n\s*\n/)[0] ?? "").replace(/\s+/g, " ").trim() || undefined;
}

function firstSentence(text: string | undefined): string {
  if (!text) return "";
  const match = /^(.+?[.!?])(\s|$)/.exec(text);
  const sentence = match?.[1] ?? text;
  return sentence.length > 220 ? `${sentence.slice(0, 220)}…` : sentence;
}

/** Makes text safe inside a Markdown table cell. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function mermaidText(text: string): string {
  return text.replace(/"/g, "#quot;");
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}
