import Anthropic from "@anthropic-ai/sdk";
import { GraphIndex } from "./query.js";
import type { CodeGraph, CodeNode } from "./types.js";

export const SUMMARY_MODEL = "claude-opus-5-5";
/** Bump when the prompt changes so cached summaries are regenerated. */
export const SUMMARY_PROMPT_VERSION = 1;

/** Beyond this the file is almost certainly generated or bundled code, not something worth summarizing. */
const MAX_SOURCE_CHARS = 400_000;

const SYSTEM_PROMPT = `Eres un ingeniero de software sénior que ayuda a un desarrollador a incorporarse a un codebase que no conoce.
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

export interface SummarizeOptions {
  /** Defaults to a client that resolves credentials from the environment (ANTHROPIC_API_KEY, `ant auth login`…). */
  client?: Anthropic;
  /** Called with each chunk of text as it is generated. */
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

/** Builds the user message: static-analysis context for the module followed by its full source. */
export function buildModulePrompt(graph: CodeGraph, fileId: string, source: string): string {
  const index = new GraphIndex(graph);
  const file = index.node(fileId);
  if (!file || file.kind !== "file") throw new Error(`"${fileId}" no es un archivo del grafo`);

  const symbols = descendants(index, fileId);
  const symbolIds = new Set(symbols.map((s) => s.id));
  const sections: string[] = [`Archivo: ${fileId}`];

  if (symbols.length) {
    sections.push(
      "Símbolos declarados:\n" +
        symbols
          .map((s) => {
            const name = s.id.slice(s.id.indexOf("#") + 1);
            const flags = s.exported ? ", exportado" : "";
            return `- ${s.kind} ${name} (líneas ${s.line}-${s.endLine}${flags})${s.signature ? `: ${s.signature}` : ""}`;
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
  for (const id of [fileId, ...symbolIds]) {
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

/** Generates a natural-language summary of one module (file). Streams text through `onText` and returns it whole. */
export async function summarizeModule(
  graph: CodeGraph,
  fileId: string,
  source: string,
  options: SummarizeOptions = {},
): Promise<string> {
  if (source.length > MAX_SOURCE_CHARS) {
    throw new Error(
      `${fileId} tiene ${Math.round(source.length / 1000)} KB; parece código generado o empaquetado y no se resume.`,
    );
  }
  const client = options.client ?? new Anthropic();
  const prompt = buildModulePrompt(graph, fileId, source);

  const stream = client.beta.messages.stream(
    {
      model: SUMMARY_MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      // If a safety classifier declines the request, the API retries it on Anthropic's recommended model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    },
    { signal: options.signal },
  );
  if (options.onText) stream.on("text", options.onText);

  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw new Error("El modelo declinó resumir este archivo.");
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (message.stop_reason === "max_tokens") return `${text}\n\n_(Resumen truncado por longitud)_`;
  return text;
}

/** Turns SDK errors into messages a user can act on. */
export function describeSummaryError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return "Credenciales de Anthropic inválidas. Revisa ANTHROPIC_API_KEY.";
  }
  if (error instanceof Anthropic.RateLimitError) return "Límite de uso de la API alcanzado; intenta en unos minutos.";
  if (error instanceof Anthropic.APIConnectionError) return "No se pudo conectar con la API de Anthropic.";
  if (error instanceof Anthropic.APIError) return `Error de la API (${error.status}): ${error.message}`;
  if (error instanceof Anthropic.AnthropicError) {
    // Thrown by the client constructor when no credentials can be resolved.
    return `${error.message}\nDefine ANTHROPIC_API_KEY o ejecuta \`ant auth login\`.`;
  }
  return error instanceof Error ? error.message : String(error);
}

function descendants(index: GraphIndex, id: string): CodeNode[] {
  return index.children(id).flatMap((child) => [child, ...descendants(index, child.id)]);
}
