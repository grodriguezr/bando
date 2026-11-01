import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { analyze, type CodeGraph, type EdgeKind } from "../dist/index.js";

const fixture = (name: string) => path.join(import.meta.dirname, "fixtures", name);

function edge(graph: CodeGraph, from: string, to: string, kind: EdgeKind) {
  return graph.edges.find((e) => e.from === from && e.to === to && e.kind === kind);
}

function assertEdge(graph: CodeGraph, from: string, to: string, kind: EdgeKind) {
  const related = graph.edges.filter((e) => e.from === from).map((e) => `${e.kind} → ${e.to}`);
  assert.ok(edge(graph, from, to, kind), `Falta ${from} --${kind}--> ${to}. Relaciones:\n  ${related.join("\n  ")}`);
}

describe("Python", async () => {
  const graph = await analyze(fixture("python-app"));
  const node = (id: string) => graph.nodes.find((n) => n.id === id);
  const svc = "app/servicios.py";

  test("encuentra los archivos e ignora los entornos virtuales", () => {
    assert.deepEqual(graph.languages, ["python"]);
    assert.deepEqual(
      graph.nodes
        .filter((n) => n.kind === "file")
        .map((n) => n.id)
        .sort(),
      ["app/__init__.py", "app/modelos.py", "app/repositorio.py", "app/servicios.py", "main.py"],
    );
  });

  test("extrae clases, métodos y funciones con firma, docstring y visibilidad", () => {
    assert.equal(node("app/modelos.py#Cliente")?.kind, "class");
    assert.equal(node("app/modelos.py#Cliente")?.doc, "Un cliente del sistema.");
    assert.equal(node("app/modelos.py#Cliente.__init__")?.signature, "__init__(self, nombre: str)");
    assert.equal(node("app/repositorio.py#Repositorio.buscar")?.signature, "buscar(self, nombre: str) -> Cliente");
    assert.equal(node("main.py#formatear")?.kind, "function");
    assert.equal(node(`${svc}#ClienteService.registrar`)?.exported, true);
    assert.equal(node(`${svc}#ClienteService._privado`)?.exported, false, "los nombres con _ son privados");
    assert.equal(node("app/modelos.py#Cliente.__init__")?.exported, true, "los métodos especiales son públicos");
  });

  test("resuelve imports relativos, submódulos, paquetes y librerías", () => {
    assertEdge(graph, "main.py", "app/__init__.py", "imports");
    assertEdge(graph, "app/__init__.py", svc, "imports");
    assertEdge(graph, svc, "app/repositorio.py", "imports");
    assertEdge(graph, svc, "app/modelos.py", "imports"); // from . import modelos
    assertEdge(graph, svc, "pkg:logging", "imports");
  });

  test("resuelve la herencia", () => {
    assertEdge(graph, "app/modelos.py#Cliente", "app/modelos.py#Base", "extends");
  });

  test("resuelve llamadas a través de reexportaciones, módulos y self", () => {
    assertEdge(graph, "main.py#principal", `${svc}#ClienteService`, "calls"); // vía app/__init__.py
    assertEdge(graph, `${svc}#ClienteService.registrar`, "app/modelos.py#Cliente", "calls"); // modelos.Cliente(...)
    assertEdge(graph, "app/modelos.py#Base.guardar", "app/modelos.py#Base._validar", "calls"); // self._validar()
    assertEdge(graph, "main.py", "main.py#principal", "calls"); // if __name__ == "__main__"
  });

  test("deduce tipos de asignaciones, atributos y anotaciones de retorno", () => {
    assertEdge(graph, "main.py#principal", `${svc}#ClienteService.registrar`, "calls"); // servicio = ClienteService()
    assertEdge(graph, `${svc}#ClienteService.registrar`, "app/repositorio.py#Repositorio.buscar", "calls"); // self.repo
    assertEdge(graph, `${svc}#ClienteService.registrar`, "app/modelos.py#Base.guardar", "calls"); // -> Cliente, heredado
  });

  test("las funciones pasadas como argumento cuentan como llamadas", () => {
    assertEdge(graph, "main.py#principal", "main.py#formatear", "calls"); // map(formatear, …)
  });

  test("builtins y librerías son externas; lo desconocido queda sin resolver", () => {
    assert.equal(graph.stats.unresolvedCalls, 1, "solo desconocido()");
    assert.ok(graph.stats.externalCalls >= 5, "list, map, str, log.info, super().__init__, logging.getLogger");
  });
});
