import fs from "node:fs";
import path from "node:path";
import { generateText, type GeneratedText, type GenerateOptions } from "./llm.js";
import { GraphIndex } from "./query.js";
import { folderOf } from "./targets.js";
import type { CodeGraph, CodeNode } from "./types.js";

/** Default characters of context (summaries + code) sent with a question; local models get less. */
export const DEFAULT_ASK_BUDGET = 40_000;
/** For local models, which usually run with an 8K-token context. */
export const LOCAL_ASK_BUDGET = 12_000;
/** Files and symbols considered for the context, best first. */
const MAX_FILES = 8;
const MAX_SYMBOLS = 8;

export interface AskOptions extends GenerateOptions {
  /** Summaries keyed by `summaryKey`; they make both the search and the answer much better. */
  summaries?: ReadonlyMap<string, string>;
  /** Characters of context to include. */
  budget?: number;
}

export interface Answer extends GeneratedText {
  /** Node ids (files and symbols) whose content was given to the model. */
  sources: string[];
}

const SYSTEM_PROMPT = `Eres un ingeniero de software sénior que conoce bien un codebase y responde preguntas de un
desarrollador que se está incorporando. Recibirás la pregunta y fragmentos del proyecto que una búsqueda consideró
relevantes: resúmenes de archivos, firmas y código de funciones, y una visión general si existe.

Responde en español, en Markdown, de forma directa y concreta:
- Basa la respuesta solo en el contexto dado. Si no alcanza para responder con seguridad, dilo claramente y sugiere
  qué archivos o funciones mirar o qué preguntar.
- Menciona archivos y funciones con su ruta o nombre exacto entre comillas invertidas, como \`src/app/main.ts\` o
  \`ClientesService.crear\`, tal como aparecen en el contexto. No inventes nombres.
- Si la pregunta es sobre un proceso, explica los pasos en orden.`;

/** Answers a question about the project with the most relevant parts of it as context. */
export async function askProject(graph: CodeGraph, question: string, options: AskOptions = {}): Promise<Answer> {
  const { prompt, sources } = buildAskPrompt(graph, question, options);
  const result = await generateText(SYSTEM_PROMPT, prompt, options);
  return { ...result, sources };
}

export interface RankedNode {
  node: CodeNode;
  score: number;
}

/** The request for a question, and which nodes it includes. Exported for tests and to show sources. */
export function buildAskPrompt(
  graph: CodeGraph,
  question: string,
  options: Pick<AskOptions, "summaries" | "budget"> = {},
): { prompt: string; sources: string[] } {
  const summaries = options.summaries ?? new Map<string, string>();
  const index = new GraphIndex(graph);
  const { files, symbols } = rankNodes(index, question, summaries);
  let budget = options.budget ?? DEFAULT_ASK_BUDGET;
  const sections: string[] = [`Pregunta: ${question}`];
  const sources: string[] = [];

  const guide = summaries.get("project");
  if (guide) {
    const overview = guide.slice(0, Math.min(3_000, Math.floor(budget / 5)));
    sections.push(`Visión general del proyecto:\n${overview}${overview.length < guide.length ? "\n(…)" : ""}`);
    budget -= overview.length;
  }

  const fileParts: string[] = [];
  for (const { node } of files) {
    const summary = summaries.get(`file:${node.id}`);
    const exported = index
      .children(node.id)
      .filter((c) => c.exported)
      .map((c) => c.signature ?? c.name);
    const text = summary
      ? `<file path="${node.id}">\n${summary}\n</file>`
      : `<file path="${node.id}">\nSin resumen. Exporta: ${exported.join("; ") || "nada"}\n</file>`;
    if (text.length > budget) continue;
    fileParts.push(text);
    sources.push(node.id);
    budget -= text.length;
  }
  if (fileParts.length) sections.push(`Archivos relevantes:\n${fileParts.join("\n\n")}`);

  const codeParts: string[] = [];
  for (const { node } of symbols) {
    const code = readLines(graph.root, node);
    if (!code) continue;
    const callers = index
      .incoming(node.id, "calls")
      .slice(0, 5)
      .map((e) => e.from);
    const header = `<function id="${node.id}"${callers.length ? ` llamada-por="${callers.join(", ")}"` : ""}>`;
    const text = `${header}\n${code}\n</function>`;
    if (text.length > budget) continue;
    codeParts.push(text);
    if (!sources.includes(node.id)) sources.push(node.id);
    budget -= text.length;
  }
  if (codeParts.length) sections.push(`Código de funciones relevantes:\n${codeParts.join("\n\n")}`);

  if (!fileParts.length && !codeParts.length) {
    sections.push("La búsqueda no encontró partes del proyecto relacionadas con la pregunta.");
  }
  return { prompt: sections.join("\n\n"), sources };
}

/** Files and functions whose names, docs or summaries share words with the question, best first. */
export function rankNodes(
  index: GraphIndex,
  question: string,
  summaries: ReadonlyMap<string, string>,
): { files: RankedNode[]; symbols: RankedNode[] } {
  const terms = searchTerms(question);
  if (!terms.length) return { files: [], symbols: [] };

  const fileScores = new Map<string, number>();
  const symbolScores: RankedNode[] = [];
  for (const node of index.graph.nodes) {
    if (node.kind === "package") continue;
    const name = node.kind === "file" ? node.id : node.id.slice(node.id.indexOf("#") + 1);
    let score = 3 * matches(terms, name) + matches(terms, node.doc ?? "");
    if (node.kind === "file") {
      score += 2 * matches(terms, summaries.get(`file:${node.id}`) ?? "");
      score += matches(terms, summaries.get(`folder:${folderOf(node.id)}`) ?? "") / 2;
      if (score > 0) fileScores.set(node.id, (fileScores.get(node.id) ?? 0) + score);
    } else if (score > 0) {
      symbolScores.push({ node, score });
      // A matching function also makes its file relevant.
      fileScores.set(node.file, (fileScores.get(node.file) ?? 0) + score / 2);
    }
  }
  const files = [...fileScores]
    .map(([id, score]) => ({ node: index.node(id)!, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FILES);
  const symbols = symbolScores
    .filter(({ node }) => node.kind === "function" || node.kind === "method" || node.kind === "class")
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SYMBOLS);
  return { files, symbols };
}

const STOPWORDS = new Set(
  (
    "a al algo como con cual cuales cuando de del desde donde el ella ellos en entre es esta este esto hace hacer hay " +
    "la las lo los mas me mi muy no o para pero por porque que quien se ser si sin sobre su sus te tiene todo tu un una " +
    "uno unos y ya funciona funcion codigo archivo proyecto parte " +
    "the and or of to in is it for on with what where how does do which who why when"
  ).split(" "),
);

/** Words of the question worth searching: no accents, no stopwords, reduced to a short stem. */
export function searchTerms(question: string): string[] {
  const words = normalize(question)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return [...new Set(words.map(stem))];
}

/** How many of the terms appear in `text`, at the start of one of its words (camelCase and paths included). */
function matches(terms: string[], text: string): number {
  if (!text) return 0;
  const words = new Set(
    normalize(text.replace(/([a-z])([A-Z])/g, "$1 $2"))
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3)
      .map(stem),
  );
  let count = 0;
  for (const term of terms) if (words.has(term)) count++;
  return count;
}

/** "facturación", "facturas", "factura" → "factur"; "calcular", "calcula" → "calcul"; "totales" → "total". */
function stem(word: string): string {
  const singular = word.length > 4 ? word.replace(/(es|s)$/, "") : word;
  return singular.slice(0, 6);
}

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function readLines(root: string, node: CodeNode): string | undefined {
  try {
    const lines = fs.readFileSync(path.join(root, node.file), "utf8").split("\n");
    return lines.slice(node.line - 1, node.endLine).join("\n");
  } catch {
    return undefined;
  }
}
