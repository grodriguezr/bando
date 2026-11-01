import fs from "node:fs";
import path from "node:path";
import { GraphIndex } from "./query.js";
import type { CodeNode } from "./types.js";

/** How far the call tree is followed from the starting function. */
const MAX_DEPTH = 4;
/** Functions listed in the call tree; beyond this the flow is too broad to explain in one go. */
const MAX_FUNCTIONS = 30;
/** Default characters of source code included; local models get less (see SummaryStore). */
export const DEFAULT_FLOW_SOURCE_BUDGET = 40_000;

export const FLOW_SYSTEM_PROMPT = `Eres un ingeniero de software sénior que explica a un desarrollador qué ocurre cuando se ejecuta
una parte de un codebase que no conoce. Recibirás una función de partida, el árbol de llamadas que sale de ella
(obtenido por análisis estático, solo llamadas dentro del proyecto) y el código de esas funciones.

Escribe en español, en Markdown, con estas secciones:

## Resumen
Qué logra este flujo, en dos o tres frases.

## Paso a paso
Lista numerada siguiendo la ejecución: qué hace cada función relevante y a cuál llama después. Nombra las funciones
entre comillas invertidas tal como aparecen en los datos (por ejemplo \`ClientesService.crear\`). Agrupa los pasos triviales.

## Datos y efectos
Qué entra y qué sale, y qué efectos secundarios hay: base de datos, red, archivos, estado global, eventos.

## A tener en cuenta
Validaciones, errores que se manejan (o no), condiciones que cambian el camino, partes delicadas.

Las llamadas a librerías externas no aparecen en el árbol: dedúcelas del código cuando sean importantes.
Si de algunas funciones solo tienes la firma, dilo cuando eso limite la explicación. No inventes funciones.`;

/**
 * The call tree from `startId` (breadth-first, project functions only) with the source of the
 * closest functions up to `sourceBudget` characters; the rest are listed by signature.
 */
export function buildFlowPrompt(index: GraphIndex, startId: string, sourceBudget = DEFAULT_FLOW_SOURCE_BUDGET): string {
  const start = index.node(startId);
  if (!start || start.kind === "file" || start.kind === "package") {
    throw new Error(`"${startId}" no es una función, método o clase del proyecto`);
  }

  // Breadth-first so the closest steps are the ones that get their source included.
  const depth = new Map<string, number>([[startId, 0]]);
  const order = [startId];
  for (let i = 0; i < order.length && order.length < MAX_FUNCTIONS; i++) {
    const id = order[i]!;
    if (depth.get(id)! >= MAX_DEPTH) continue;
    for (const edge of index.outgoing(id, "calls")) {
      if (depth.has(edge.to) || order.length >= MAX_FUNCTIONS) continue;
      const callee = index.node(edge.to);
      if (!callee || callee.kind === "file") continue;
      depth.set(edge.to, depth.get(id)! + 1);
      order.push(edge.to);
    }
  }
  const truncatedTree = order.length >= MAX_FUNCTIONS;

  const sources = new Map<string, string>();
  let budget = sourceBudget;
  for (const id of order) {
    const node = index.node(id)!;
    const code = readLines(index.graph.root, node);
    if (code && code.length <= budget) {
      sources.set(id, code);
      budget -= code.length;
    }
  }

  const sections = [`Función de partida: ${startId}`];
  sections.push(
    "Árbol de llamadas (cada función aparece una vez; la sangría indica quién la llama primero):\n" +
      treeLines(index, startId, new Set(order)).join("\n") +
      (truncatedTree ? `\n(Se muestran las primeras ${MAX_FUNCTIONS} funciones; el flujo continúa más allá.)` : ""),
  );

  const withoutSource = order.filter((id) => !sources.has(id));
  sections.push(
    "Código:\n" +
      order
        .filter((id) => sources.has(id))
        .map((id) => `<function id="${id}">\n${sources.get(id)}\n</function>`)
        .join("\n\n"),
  );
  if (withoutSource.length) {
    sections.push(
      "Funciones de las que solo se incluye la firma (por espacio):\n" +
        withoutSource
          .map((id) => {
            const node = index.node(id)!;
            return `- ${id}${node.signature ? `: ${node.signature}` : ""}`;
          })
          .join("\n"),
    );
  }
  return sections.join("\n\n");
}

function treeLines(index: GraphIndex, startId: string, included: Set<string>): string[] {
  const lines: string[] = [];
  const shown = new Set<string>();
  const walk = (id: string, level: number) => {
    const node = index.node(id)!;
    const where = `${node.file}:${node.line}`;
    if (shown.has(id)) {
      lines.push(`${"  ".repeat(level)}- ${id} (ya listada arriba)`);
      return;
    }
    shown.add(id);
    lines.push(`${"  ".repeat(level)}- ${id} [${node.kind}, ${where}]`);
    for (const edge of index.outgoing(id, "calls")) {
      if (included.has(edge.to) && edge.to !== id) walk(edge.to, level + 1);
    }
  };
  walk(startId, 0);
  return lines;
}

function readLines(root: string, node: CodeNode): string | undefined {
  try {
    const lines = fs.readFileSync(path.join(root, node.file), "utf8").split("\n");
    return lines.slice(node.line - 1, node.endLine).join("\n");
  } catch {
    return undefined;
  }
}
