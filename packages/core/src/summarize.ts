import fs from "node:fs";
import path from "node:path";
import { generateText, type GeneratedText, type GenerateOptions } from "./llm.js";
import { GraphIndex } from "./query.js";
import { folderOf, listFolders, type SummaryTarget } from "./targets.js";
export { AUTOMATIC_MODEL } from "./trivial.js";
import { AUTOMATIC_MODEL, automaticSummary } from "./trivial.js";
import { buildFlowPrompt, FLOW_SYSTEM_PROMPT } from "./flow.js";
import type { CodeGraph, CodeNode } from "./types.js";

export {
  DEFAULT_LOCAL_URL,
  describeSummaryError,
  LocalModelError,
  SUMMARY_MODEL,
  type GeneratedText,
  type GenerateOptions,
  type SummaryProvider,
} from "./llm.js";
export {
  findUnknownReferences,
  folderOf,
  listFolders,
  looksLikeSourceFile,
  summaryKey,
  type SummaryTarget,
} from "./targets.js";

/** Bump when a prompt changes so cached summaries are flagged as stale. */
export const SUMMARY_PROMPT_VERSION = 3;

/** Beyond this the file is almost certainly generated or bundled code, not something worth summarizing. */
const MAX_SOURCE_CHARS = 400_000;
const MAX_README_CHARS = 8_000;
const MAX_FOLDERS_IN_GUIDE = 80;
/** Up to this many files, the guide lists every file so the model never has to guess paths. */
const MAX_FILES_LISTED_IN_GUIDE = 400;

export interface SummaryContext {
  /**
   * Summaries generated earlier, keyed by `summaryKey(target)`. Folder summaries build on their
   * files' summaries and the project guide on its folders'; missing ones fall back to static data.
   */
  summaries?: ReadonlyMap<string, string>;
  /** Characters of source code a flow explanation may include; smaller for models with short context. */
  sourceBudget?: number;
}

/** Generates a summary of a file, folder, flow or the whole project. Streams text through `onText`. */
export async function summarize(
  graph: CodeGraph,
  target: SummaryTarget,
  options: GenerateOptions & SummaryContext = {},
): Promise<GeneratedText> {
  const { system, prompt } = buildSummaryPrompt(graph, target, options);
  if (target.kind === "file") {
    // Types, constants, translations and re-export files are described without a model.
    const source = fs.readFileSync(path.join(graph.root, target.id), "utf8");
    const text = automaticSummary(graph, target.id, source);
    if (text) {
      options.onText?.(text);
      return { text, model: AUTOMATIC_MODEL };
    }
  }
  return generateText(system, prompt, options);
}

/** The exact request a summary is generated from; also useful to detect when a cached summary is stale. */
export function buildSummaryPrompt(
  graph: CodeGraph,
  target: SummaryTarget,
  context: SummaryContext = {},
): { system: string; prompt: string } {
  const summaries = context.summaries ?? new Map<string, string>();
  const index = new GraphIndex(graph);
  if (target.kind === "file") {
    const source = fs.readFileSync(path.join(graph.root, target.id), "utf8");
    if (source.length > MAX_SOURCE_CHARS) {
      throw new Error(
        `${target.id} tiene ${Math.round(source.length / 1000)} KB; parece código generado o empaquetado y no se resume.`,
      );
    }
    return { system: FILE_SYSTEM_PROMPT, prompt: buildModulePrompt(graph, target.id, source) };
  }
  if (target.kind === "folder")
    return { system: FOLDER_SYSTEM_PROMPT, prompt: folderPrompt(index, target.id, summaries) };
  if (target.kind === "flow") {
    return { system: FLOW_SYSTEM_PROMPT, prompt: buildFlowPrompt(index, target.id, context.sourceBudget) };
  }
  return { system: PROJECT_SYSTEM_PROMPT, prompt: projectPrompt(index, summaries) };
}

// ── Files ────────────────────────────────────────────────────────────────

const FILE_SYSTEM_PROMPT = `Eres un ingeniero de software sénior que ayuda a un desarrollador a incorporarse a un codebase que no conoce.
Recibirás un módulo (un archivo JavaScript/TypeScript), los datos que un análisis estático extrajo de él
(símbolos, imports, quién lo usa) y su código fuente completo.

Escribe un resumen en español, en Markdown, con estas secciones (omite las que no aporten nada):

## Propósito
Uno o dos párrafos: qué responsabilidad tiene este módulo dentro del proyecto y por qué existe.

## Piezas principales
Lista de las clases, funciones o componentes importantes, con una línea cada una explicando qué hacen. Usa \`código\` para los nombres.

## Cómo se usa
Quién lo usa y para qué, basándote en los importadores y llamadores que se te dan. Si no lo usa nadie, dilo: puede ser un punto de entrada o código muerto.

## Dependencias
Qué módulos internos y librerías usa, y para qué. Solo las relevantes.

## A tener en cuenta
Lo que alguien que va a modificar este archivo debería saber: efectos secundarios, estado compartido, supuestos implícitos, partes delicadas.

Sé concreto y breve: el lector quiere orientarse rápido, no leer documentación exhaustiva. No repitas el código.
Basa todo en lo que ves; si algo es una inferencia, dilo.`;

/** Static-analysis context for the module followed by its full source. */
export function buildModulePrompt(graph: CodeGraph, fileId: string, source: string): string {
  const index = new GraphIndex(graph);
  const file = index.node(fileId);
  if (!file || file.kind !== "file") throw new Error(`"${fileId}" no es un archivo del grafo`);

  const symbols = descendants(index, fileId);
  const sections: string[] = [`Archivo: ${fileId}`];

  if (symbols.length) {
    sections.push(
      "Símbolos declarados:\n" +
        symbols
          .map((s) => {
            const flags = s.exported ? ", exportado" : "";
            return `- ${s.kind} ${symbolName(s)} (líneas ${s.line}-${s.endLine}${flags})${s.signature ? `: ${s.signature}` : ""}`;
          })
          .join("\n"),
    );
  }

  const imports = index.outgoing(fileId, "imports").map((e) => e.to.replace(/^pkg:/, "paquete "));
  if (imports.length) sections.push(`Importa:\n${imports.map((i) => `- ${i}`).join("\n")}`);

  const importers = index.incoming(fileId, "imports").map((e) => e.from);
  sections.push(
    importers.length
      ? `Lo importan:\n${importers.map((i) => `- ${i}`).join("\n")}`
      : "Ningún otro archivo del proyecto lo importa.",
  );

  // Calls that cross the file boundary, in both directions.
  const callersOutside = new Map<string, string[]>();
  const calleesOutside = new Set<string>();
  for (const id of [fileId, ...symbols.map((s) => s.id)]) {
    for (const edge of index.incoming(id, "calls")) {
      const caller = index.node(edge.from);
      if (caller && caller.file !== fileId) {
        const target = id.slice(id.indexOf("#") + 1);
        callersOutside.set(target, [...(callersOutside.get(target) ?? []), edge.from]);
      }
    }
    for (const edge of index.outgoing(id, "calls")) {
      const callee = index.node(edge.to);
      if (callee && callee.file !== fileId) calleesOutside.add(edge.to);
    }
  }
  if (callersOutside.size) {
    sections.push(
      "Llamados desde otros archivos:\n" +
        [...callersOutside].map(([target, callers]) => `- ${target} ← ${callers.join(", ")}`).join("\n"),
    );
  }
  if (calleesOutside.size) {
    sections.push(`Llama a símbolos de otros archivos:\n${[...calleesOutside].map((c) => `- ${c}`).join("\n")}`);
  }

  sections.push(`Código fuente:\n<source path="${fileId}">\n${source}\n</source>`);
  return sections.join("\n\n");
}

// ── Folders ──────────────────────────────────────────────────────────────

const FOLDER_SYSTEM_PROMPT = `Eres un ingeniero de software sénior que ayuda a un desarrollador a incorporarse a un codebase que no conoce.
Recibirás una carpeta del proyecto: sus archivos con lo que exportan, el propósito de cada uno (cuando ya se resumió)
y cómo se relaciona la carpeta con el resto del proyecto según un análisis estático. No recibirás el código fuente.

Escribe un resumen en español, en Markdown, con estas secciones (omite las que no aporten nada):

## Propósito
Qué responsabilidad tiene esta carpeta dentro del proyecto, en uno o dos párrafos.

## Contenido
Los archivos importantes y el papel de cada uno, en una línea. Si son muchos, agrúpalos.

## Relación con el resto
Qué partes del proyecto usa y cuáles la usan a ella. Indica si parece una capa base, una de orquestación, una interfaz, etc.

## A tener en cuenta
Lo que conviene saber antes de trabajar aquí.

Menciona archivos y carpetas con su ruta exacta entre comillas invertidas, como \`src/app/main.ts\`.
Menciona solo archivos y carpetas que aparezcan en los datos: no inventes rutas.
Sé concreto y breve. Si a algunos archivos les falta el resumen, básate en sus nombres y exportaciones y dilo cuando infieras.`;

function folderPrompt(index: GraphIndex, dir: string, summaries: ReadonlyMap<string, string>): string {
  const files = index.graph.nodes.filter((n) => n.kind === "file" && folderOf(n.id) === dir);
  if (!files.length) throw new Error(`"${dir}" no es una carpeta con archivos analizados`);
  const inFolder = new Set(files.map((f) => f.id));

  const sections = [`Carpeta: ${dir}`];
  const subfolders = listFolders(index.graph).filter((f) => f !== dir && (dir === "." || f.startsWith(`${dir}/`)));
  if (subfolders.length) sections.push(`Subcarpetas: ${subfolders.map((f) => `\`${f}\``).join(", ")}`);

  let missing = 0;
  sections.push(
    `Archivos (${files.length}):\n` +
      files
        .map((file) => {
          const exported = descendants(index, file.id)
            .filter((s) => s.exported && s.kind !== "method")
            .map(symbolName);
          const purpose = purposeOf(summaries.get(`file:${file.id}`));
          if (!purpose) missing++;
          return [
            `- ${file.id}`,
            exported.length ? `  Exporta: ${exported.join(", ")}` : undefined,
            purpose ? `  Propósito: ${purpose}` : undefined,
          ]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n"),
  );
  if (missing) sections.push(`(${missing} de ${files.length} archivos todavía no tienen resumen.)`);

  const uses = new Map<string, number>();
  const usedBy = new Map<string, number>();
  const packages = new Map<string, number>();
  for (const edge of index.graph.edges) {
    if (edge.kind !== "imports") continue;
    if (inFolder.has(edge.from) && !inFolder.has(edge.to)) {
      if (edge.to.startsWith("pkg:")) increment(packages, edge.to.slice(4));
      else increment(uses, folderOf(edge.to));
    } else if (!inFolder.has(edge.from) && inFolder.has(edge.to)) {
      increment(usedBy, folderOf(edge.from));
    }
  }
  if (uses.size) sections.push(`Importa de otras carpetas:\n${countList(uses)}`);
  if (usedBy.size) sections.push(`La importan desde:\n${countList(usedBy)}`);
  else sections.push("Ninguna otra carpeta la importa.");
  if (packages.size) sections.push(`Paquetes externos:\n${countList(packages)}`);

  const calledFromOutside = new Map<string, number>();
  for (const file of files) {
    for (const symbol of descendants(index, file.id)) {
      const outside = index.incoming(symbol.id, "calls").filter((e) => !inFolder.has(index.node(e.from)?.file ?? ""));
      if (outside.length) calledFromOutside.set(symbol.id, outside.length);
    }
  }
  if (calledFromOutside.size) {
    sections.push(`Símbolos más usados desde fuera de la carpeta:\n${countList(calledFromOutside, 15)}`);
  }
  return sections.join("\n\n");
}

// ── Project ──────────────────────────────────────────────────────────────

const PROJECT_SYSTEM_PROMPT = `Eres un ingeniero de software sénior que prepara a un desarrollador para empezar a trabajar en un proyecto que no conoce.
Recibirás la estructura del proyecto obtenida por análisis estático (carpetas y sus dependencias, puntos de entrada,
símbolos más usados, dependencias externas), los resúmenes de las carpetas que ya se generaron y su README.

Escribe una guía en español, en Markdown, con estas secciones:

## De qué se trata
Qué hace el proyecto y para quién, en un párrafo.

## Arquitectura
Las partes principales (carpetas o capas), qué responsabilidad tiene cada una y cómo dependen entre sí.

## Flujos principales
Dos o tres recorridos típicos a través del código (por ejemplo: desde un punto de entrada hasta el resultado), nombrando los archivos involucrados.

## Por dónde empezar
Lista numerada de 5 a 8 archivos para leer en ese orden, con una línea explicando por qué cada uno.

## Conceptos clave
Términos, tipos o abstracciones del dominio que conviene entender primero.

## Cómo ponerlo en marcha
Comandos para instalar, ejecutar y probar, si se desprenden del package.json o el README.

Menciona archivos y carpetas con su ruta exacta entre comillas invertidas, como \`src/app/main.ts\`, tal como aparecen en los datos.
Menciona solo archivos que estén en la lista de carpetas y archivos: no inventes rutas ni nombres de archivo.
Sé concreto: el lector quiere orientarse en minutos. Distingue lo que ves en los datos de lo que infieres.`;

function projectPrompt(index: GraphIndex, summaries: ReadonlyMap<string, string>): string {
  const { graph } = index;
  const sections = [`Proyecto: ${path.basename(graph.root)}`];

  const manifest = readText(path.join(graph.root, "package.json"));
  if (manifest) {
    try {
      const pkg = JSON.parse(manifest) as { name?: string; description?: string; scripts?: Record<string, string> };
      sections.push(
        `package.json:\n${JSON.stringify({ name: pkg.name, description: pkg.description, scripts: pkg.scripts }, null, 2)}`,
      );
    } catch {
      // An invalid package.json is simply left out.
    }
  }

  const { stats } = graph;
  sections.push(`Tamaño: ${stats.files} archivos, ${stats.symbols} símbolos (clases, funciones, métodos…).`);

  const files = graph.nodes.filter((n) => n.kind === "file");
  const folders = listFolders(graph)
    .map((dir) => ({ dir, files: files.filter((f) => folderOf(f.id) === dir) }))
    .sort((a, b) => b.files.length - a.files.length);
  const shown = folders.slice(0, MAX_FOLDERS_IN_GUIDE).sort((a, b) => a.dir.localeCompare(b.dir));
  const listAllFiles = files.length <= MAX_FILES_LISTED_IN_GUIDE;
  let missing = 0;
  sections.push(
    `Carpetas (${folders.length}):\n` +
      shown
        .map(({ dir, files: inDir }) => {
          const purpose = purposeOf(summaries.get(`folder:${dir}`));
          if (!purpose) missing++;
          const names = inDir.map((f) => f.name);
          const limit = listAllFiles ? Infinity : 8;
          const list =
            names.slice(0, limit).join(", ") + (names.length > limit ? `, … (+${names.length - limit})` : "");
          return [`- ${dir} (${inDir.length} archivos)`, purpose && `  Propósito: ${purpose}`, `  Archivos: ${list}`]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n") +
      (folders.length > shown.length ? `\n(Se omiten ${folders.length - shown.length} carpetas pequeñas.)` : ""),
  );
  if (missing) sections.push(`(${missing} carpetas todavía no tienen resumen.)`);

  const folderDeps = new Map<string, number>();
  const packages = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.kind !== "imports") continue;
    if (edge.to.startsWith("pkg:")) increment(packages, edge.to.slice(4));
    else if (folderOf(edge.from) !== folderOf(edge.to))
      increment(folderDeps, `${folderOf(edge.from)} → ${folderOf(edge.to)}`);
  }
  if (folderDeps.size) sections.push(`Dependencias entre carpetas (importaciones):\n${countList(folderDeps, 40)}`);
  if (packages.size) sections.push(`Dependencias externas (archivos que las usan):\n${countList(packages, 20)}`);

  const entries = index.entryPoints().slice(0, 25);
  if (entries.length) {
    sections.push(
      `Puntos de entrada (exportados y sin llamadores internos):\n${entries.map((n) => `- ${n.id}`).join("\n")}`,
    );
  }
  const mostCalled = index.mostCalled(15);
  if (mostCalled.length) {
    sections.push(
      `Símbolos más llamados:\n${mostCalled.map(({ node, callers }) => `- ${node.id} (${callers} llamadores)`).join("\n")}`,
    );
  }
  const hubs = new Map(files.map((f) => [f.id, index.incoming(f.id, "imports").length]));
  sections.push(`Archivos más importados:\n${countList(new Map([...hubs].filter(([, n]) => n > 0)), 10)}`);

  const readmeName = ["README.md", "readme.md", "README", "Readme.md"].find((f) =>
    fs.existsSync(path.join(graph.root, f)),
  );
  const readme = readmeName && readText(path.join(graph.root, readmeName));
  if (readme) {
    const cut = readme.length > MAX_README_CHARS;
    sections.push(
      `README (${readmeName}${cut ? `, primeros ${MAX_README_CHARS} caracteres de ${readme.length}` : ""}):\n` +
        `<readme>\n${readme.slice(0, MAX_README_CHARS)}\n</readme>`,
    );
  } else {
    sections.push("El proyecto no tiene README.");
  }
  return sections.join("\n\n");
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** The "Propósito" section of a summary, which is what parent summaries build on. */
function purposeOf(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  const section = /#+\s*Prop[oó]sito\s*\n+([\s\S]*?)(?=\n#+\s|$)/i.exec(summary)?.[1];
  const text = (section ?? summary.split(/\n\s*\n/)[0] ?? "").replace(/\s+/g, " ").trim();
  return text.length > 700 ? `${text.slice(0, 700)}…` : text || undefined;
}

function descendants(index: GraphIndex, id: string): CodeNode[] {
  return index.children(id).flatMap((child) => [child, ...descendants(index, child.id)]);
}

function symbolName(node: CodeNode): string {
  return node.id.slice(node.id.indexOf("#") + 1);
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function countList(map: Map<string, number>, limit = Infinity): string {
  const sorted = [...map].sort((a, b) => b[1] - a[1]);
  const lines = sorted.slice(0, limit).map(([key, n]) => `- ${key} (${n})`);
  if (sorted.length > limit) lines.push(`- … y ${sorted.length - limit} más`);
  return lines.join("\n");
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}
