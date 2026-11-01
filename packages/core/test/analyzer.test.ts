import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { analyzeProject, GraphIndex, type CodeGraph, type EdgeKind } from "../dist/index.js";
import { findWorkspacePackages } from "../dist/workspaces.js";

const fixture = (name: string) => path.join(import.meta.dirname, "fixtures", name);

function edge(graph: CodeGraph, from: string, to: string, kind: EdgeKind) {
  return graph.edges.find((e) => e.from === from && e.to === to && e.kind === kind);
}

function assertEdge(graph: CodeGraph, from: string, to: string, kind: EdgeKind) {
  const found = edge(graph, from, to, kind);
  const related = graph.edges.filter((e) => e.from === from).map((e) => `${e.kind} → ${e.to}`);
  assert.ok(found, `Falta ${from} --${kind}--> ${to}. Relaciones de ${from}:\n  ${related.join("\n  ")}`);
  return found;
}

describe("proyecto básico", () => {
  const graph = analyzeProject(fixture("basic"));
  const index = new GraphIndex(graph);
  const shapes = "src/shapes.ts";
  const main = "src/main.ts";

  test("usa el tsconfig del proyecto e incluye archivos JS", () => {
    assert.equal(graph.tsconfig, "tsconfig.json");
    assert.deepEqual(
      graph.nodes
        .filter((n) => n.kind === "file")
        .map((n) => n.id)
        .sort(),
      ["src/main.ts", "src/shapes.ts", "src/util.js"],
    );
  });

  test("extrae clases, interfaces, métodos y funciones flecha", () => {
    const kinds = Object.fromEntries(
      graph.nodes.filter((n) => n.file === shapes && n.kind !== "file").map((n) => [n.id, n.kind]),
    );
    assert.deepEqual(kinds, {
      [`${shapes}#Shape`]: "interface",
      [`${shapes}#Base`]: "class",
      [`${shapes}#Base.describe`]: "method",
      [`${shapes}#Circle`]: "class",
      [`${shapes}#Circle.constructor`]: "method",
      [`${shapes}#Circle.area`]: "method",
      [`${shapes}#format`]: "function",
    });
  });

  test("registra firma, documentación y exportación", () => {
    assert.equal(index.node(`${shapes}#Shape`)?.doc, "Contrato común de todas las figuras.");
    assert.equal(index.node(`${shapes}#format`)?.signature, "format(n: number): string");
    assert.equal(index.node(`${shapes}#format`)?.exported, true);
    assert.equal(index.node(`${main}#main`)?.exported, false);
  });

  test("resuelve herencia e implementación", () => {
    assertEdge(graph, `${shapes}#Circle`, `${shapes}#Base`, "extends");
    assertEdge(graph, `${shapes}#Base`, `${shapes}#Shape`, "implements");
  });

  test("resuelve llamadas, constructores, métodos heredados y funciones de JS", () => {
    assertEdge(graph, `${main}#main`, `${shapes}#Circle`, "calls");
    assertEdge(graph, `${main}#main`, `${shapes}#Base.describe`, "calls");
    assertEdge(graph, `${main}#main`, "src/util.js#sum", "calls");
    assertEdge(graph, `${shapes}#Base.describe`, `${shapes}#format`, "calls");
    // El código a nivel de módulo se atribuye al archivo.
    assertEdge(graph, main, `${main}#main`, "calls");
  });

  test("cuenta las llamadas repetidas en una sola relación", () => {
    const area = assertEdge(graph, `${main}#main`, `${shapes}#Circle.area`, "calls");
    assert.equal(area.count, 2);
    assert.deepEqual(area.lines, [7]);
  });

  test("las llamadas a librerías y globales cuentan como externas, no como internas", () => {
    assert.ok(graph.stats.externalCalls > 0, "console.log y toFixed deberían ser externas");
    assert.ok(!graph.edges.some((e) => e.kind === "calls" && !graph.nodes.some((n) => n.id === e.to)));
  });

  test("registra los imports entre archivos", () => {
    assertEdge(graph, main, shapes, "imports");
    assertEdge(graph, main, "src/util.js", "imports");
  });

  test("detecta puntos de entrada: exportados y sin llamadores", () => {
    const entries = index.entryPoints().map((n) => n.id);
    assert.ok(entries.includes(`${main}#unused`));
    assert.ok(!entries.includes(`${shapes}#format`), "format tiene llamadores");
  });
});

describe("monorepo", () => {
  const graph = analyzeProject(fixture("monorepo"));
  const app = "packages/app/src/main.ts";

  test("detecta los paquetes del workspace", () => {
    const names = findWorkspacePackages(fixture("monorepo"))
      .map((p) => p.name)
      .sort();
    assert.deepEqual(names, ["@demo/app", "@demo/lib"]);
  });

  test("los imports entre paquetes apuntan al código fuente, no a paquetes externos", () => {
    assertEdge(graph, app, "packages/lib/src/index.ts", "imports");
    assertEdge(graph, app, "packages/lib/src/math.ts", "imports");
    const packages = graph.nodes.filter((n) => n.kind === "package").map((n) => n.name);
    assert.deepEqual(packages, ["node:fs"]);
  });

  test("resuelve llamadas entre paquetes, incluso a través de re-exportaciones", () => {
    const add = assertEdge(graph, `${app}#run`, "packages/lib/src/math.ts#add", "calls");
    assert.equal(add.count, 2);
  });

  test("lee workspaces de pnpm", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bando-pnpm-"));
    try {
      fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n  - \"!apps/ignored\"\n");
      fs.mkdirSync(path.join(root, "apps", "web"), { recursive: true });
      fs.writeFileSync(path.join(root, "apps", "web", "package.json"), '{ "name": "web" }');
      assert.deepEqual(
        findWorkspacePackages(root).map((p) => p.name),
        ["web"],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("patrones de React y servicios", () => {
  const graph = analyzeProject(fixture("react-like"));
  const index = new GraphIndex(graph);
  const page = "src/page.ts";
  const api = "src/api.ts";

  test("funciones envueltas en useCallback/memo son funciones", () => {
    const cargar = index.node(`${page}#Page.cargar`);
    assert.equal(cargar?.kind, "function");
    assert.equal(cargar?.signature, "cargar(): Promise<void>");
    assertEdge(graph, `${page}#Page`, `${page}#Page.cargar`, "calls");
  });

  test("las funciones de objetos de servicios se declaran con el nombre del objeto", () => {
    const listar = index.node(`${api}#usuariosApi.listar`);
    assert.equal(listar?.kind, "function");
    assert.equal(listar?.exported, true, "se exporta a través del objeto");
    assert.equal(index.node(`${api}#usuariosApi.crear`)?.kind, "function");
    assertEdge(graph, `${page}#Page.cargar`, `${api}#usuariosApi.listar`, "calls");
    assertEdge(graph, `${page}#Page`, `${api}#usuariosApi.crear`, "calls");
    assertEdge(graph, `${api}#usuariosApi.listar`, `${api}#http.get`, "calls");
  });

  test("las variables que guardan funciones se resuelven por su tipo", () => {
    // setNombre viene de una función implementada en el proyecto.
    assertEdge(graph, `${page}#Page.cargar`, "src/hooks.ts#useStateLike.set", "calls");
  });

  test("las de librerías cuentan como externas y lo dinámico queda sin resolver", () => {
    assert.ok(!edge(graph, `${page}#Page`, `${page}#Page`, "calls"), "no inventa una llamada recursiva");
    assert.equal(graph.stats.unresolvedCalls, 1, "solo elegir() queda sin resolver");
    assert.ok(!edge(graph, "src/Boton.tsx#Boton", "src/Boton.tsx#Boton", "calls"));
  });

  test("las funciones pasadas como argumento o prop cuentan como llamadas", () => {
    const boton = "src/Boton.tsx#Boton";
    assertEdge(graph, boton, "src/Boton.tsx#formatear", "calls"); // [1, 2].map(formatear)
    const guardar = assertEdge(graph, boton, "src/Boton.tsx#Boton.guardar", "calls"); // setTimeout + onClick
    assert.deepEqual(guardar.lines, [10, 11]);
  });
});
