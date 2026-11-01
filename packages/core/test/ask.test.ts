import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { analyzeProject, GraphIndex } from "../dist/index.js";
import { buildAskPrompt, rankNodes, searchTerms } from "../dist/ask.js";

const fixture = (name: string) => path.join(import.meta.dirname, "fixtures", name);

describe("preguntar al proyecto", () => {
  const graph = analyzeProject(fixture("basic"));
  const index = new GraphIndex(graph);

  test("extrae términos sin tildes, sin palabras vacías y con raíz común", () => {
    assert.deepEqual(searchTerms("¿Dónde se calcula el ÁREA de los círculos?"), ["calcul", "area", "circul"]);
    assert.deepEqual(searchTerms("facturación facturas factura"), ["factur"]);
    assert.deepEqual(searchTerms("total totales"), ["total"]);
  });

  test("encuentra las funciones y archivos por su nombre, incluso en camelCase", () => {
    const { files, symbols } = rankNodes(index, "¿cómo se calcula el área?", new Map());
    assert.equal(symbols[0]?.node.id, "src/shapes.ts#Circle.area");
    assert.equal(files[0]?.node.id, "src/shapes.ts");
  });

  test("los resúmenes permiten encontrar archivos por lo que hacen", () => {
    const summaries = new Map([["file:src/util.js", "## Propósito\nSuma una lista de números."]]);
    const { files } = rankNodes(index, "¿dónde se suman números?", summaries);
    assert.equal(files[0]?.node.id, "src/util.js");
  });

  test("el prompt incluye resúmenes, código y la lista de fuentes", () => {
    const summaries = new Map([["file:src/shapes.ts", "## Propósito\nFiguras geométricas."]]);
    const { prompt, sources } = buildAskPrompt(graph, "¿cómo se calcula el área?", { summaries });
    assert.match(prompt, /<file path="src\/shapes\.ts">\n## Propósito\nFiguras geométricas\./);
    assert.match(prompt, /<function id="src\/shapes\.ts#Circle\.area" llamada-por="src\/main\.ts#main">/);
    assert.ok(sources.includes("src/shapes.ts") && sources.includes("src/shapes.ts#Circle.area"));
  });

  test("respeta el presupuesto y avisa si no encuentra nada", () => {
    const { prompt, sources } = buildAskPrompt(graph, "¿cómo se calcula el área?", { budget: 60 });
    assert.ok(prompt.length < 400 && sources.length <= 1);
    assert.match(buildAskPrompt(graph, "¿dónde se envían correos?").prompt, /no encontró partes/);
  });
});
