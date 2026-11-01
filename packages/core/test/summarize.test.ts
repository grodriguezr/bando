import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { analyzeProject } from "../dist/index.js";
import { buildSummaryPrompt, folderOf, listFolders, summaryKey } from "../dist/summarize.js";

const fixture = (name: string) => path.join(import.meta.dirname, "fixtures", name);

describe("objetivos de resumen", () => {
  test("identifica archivos, carpetas y el proyecto", () => {
    assert.equal(summaryKey({ kind: "file", id: "src/a.ts" }), "file:src/a.ts");
    assert.equal(summaryKey({ kind: "folder", id: "src" }), "folder:src");
    assert.equal(summaryKey({ kind: "project" }), "project");
    assert.equal(folderOf("src/a/b.ts"), "src/a");
    assert.equal(folderOf("index.ts"), ".");
  });

  test("lista las carpetas con archivos analizados", () => {
    const graph = analyzeProject(fixture("monorepo"));
    assert.deepEqual(listFolders(graph), ["packages/app/src", "packages/lib/src"]);
  });
});

describe("prompt de archivo", () => {
  test("incluye contexto del análisis y el código completo", () => {
    const graph = analyzeProject(fixture("basic"));
    const { prompt } = buildSummaryPrompt(graph, { kind: "file", id: "src/shapes.ts" });
    assert.match(prompt, /Archivo: src\/shapes\.ts/);
    assert.match(prompt, /class Circle .*exportado/);
    assert.match(prompt, /Lo importan:\n- src\/main\.ts/);
    assert.match(prompt, /export const format = \(n: number\)/, "debe incluir el código fuente");
  });
});

describe("prompt de carpeta", () => {
  const graph = analyzeProject(fixture("monorepo"));

  test("sin resúmenes previos usa los datos estáticos y lo indica", () => {
    const { prompt } = buildSummaryPrompt(graph, { kind: "folder", id: "packages/lib/src" });
    assert.match(prompt, /- packages\/lib\/src\/math\.ts\n {2}Exporta: add/);
    assert.match(prompt, /2 de 2 archivos todavía no tienen resumen/);
    assert.match(prompt, /La importan desde:\n- packages\/app\/src \(2\)/);
    assert.doesNotMatch(prompt, /return a \+ b/, "no debe incluir código fuente");
  });

  test("usa solo la sección Propósito de los resúmenes de sus archivos", () => {
    const summaries = new Map([
      ["file:packages/lib/src/math.ts", "## Propósito\nOperaciones aritméticas.\n\n## Piezas principales\n- `add`"],
    ]);
    const { prompt } = buildSummaryPrompt(graph, { kind: "folder", id: "packages/lib/src" }, { summaries });
    assert.match(prompt, /Propósito: Operaciones aritméticas\./);
    assert.doesNotMatch(prompt, /Piezas principales/);
    assert.match(prompt, /1 de 2 archivos todavía no tienen resumen/);
  });

  test("rechaza carpetas sin archivos analizados", () => {
    assert.throws(() => buildSummaryPrompt(graph, { kind: "folder", id: "no/existe" }), /no es una carpeta/);
  });
});

describe("prompt de proyecto", () => {
  const graph = analyzeProject(fixture("monorepo"));

  test("resume la estructura: carpetas, dependencias entre ellas y puntos de entrada", () => {
    const { prompt } = buildSummaryPrompt(graph, { kind: "project" });
    assert.match(prompt, /Proyecto: monorepo/);
    assert.match(prompt, /Carpetas \(2\):/);
    assert.match(prompt, /packages\/app\/src → packages\/lib\/src \(2\)/);
    assert.match(prompt, /Puntos de entrada[^\n]*:\n- packages\/app\/src\/main\.ts#run/);
    assert.match(prompt, /El proyecto no tiene README/);
  });

  test("usa los resúmenes de carpetas cuando existen", () => {
    const summaries = new Map([["folder:packages/lib/src", "## Propósito\nBiblioteca de matemáticas compartida."]]);
    const { prompt } = buildSummaryPrompt(graph, { kind: "project" }, { summaries });
    assert.match(prompt, /- packages\/lib\/src \(2 archivos\)\n {2}Propósito: Biblioteca de matemáticas compartida\./);
    assert.match(prompt, /1 carpetas todavía no tienen resumen/);
  });
});
