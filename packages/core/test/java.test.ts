import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { analyze, type CodeGraph, type EdgeKind } from "../dist/index.js";

const fixture = (name: string) => path.join(import.meta.dirname, "fixtures", name);

function assertEdge(graph: CodeGraph, from: string, to: string, kind: EdgeKind) {
  const found = graph.edges.find((e) => e.from === from && e.to === to && e.kind === kind);
  const related = graph.edges.filter((e) => e.from === from).map((e) => `${e.kind} → ${e.to}`);
  assert.ok(found, `Falta ${from} --${kind}--> ${to}. Relaciones:\n  ${related.join("\n  ")}`);
  return found;
}

describe("Java", async () => {
  const graph = await analyze(fixture("java-app"));
  const node = (id: string) => graph.nodes.find((n) => n.id === id);
  const base = "src/main/java/com/demo";
  const owner = `${base}/model/Owner.java`;
  const pet = `${base}/model/Pet.java`;
  const repo = `${base}/owner/OwnerRepository.java`;
  const formats = `${base}/owner/Formats.java`;
  const service = `${base}/owner/OwnerService.java`;
  const register = `${service}#OwnerService.register`;

  test("encuentra los archivos e ignora la carpeta de compilación", () => {
    assert.deepEqual(graph.languages, ["java"]);
    assert.equal(graph.nodes.filter((n) => n.kind === "file").length, 6);
    assert.ok(!graph.nodes.some((n) => n.file.startsWith("target/")));
  });

  test("extrae clases, records, enums, interfaces y sobrecargas", () => {
    assert.equal(node(`${owner}#Owner`)?.doc, "Un dueño de mascotas.");
    assert.equal(node(`${pet}#Pet`)?.kind, "class");
    assert.equal(node(`${repo}#OwnerRepository`)?.kind, "interface");
    assert.equal(node(`${repo}#OwnerRepository.findById`)?.exported, true, "los métodos de interfaz son públicos");
    assert.equal(node(`${owner}#Owner.addPet~2`)?.signature, "addPet(String name, int age): Pet");
    assert.equal(node(`${service}#OwnerService.helper`)?.exported, false);
    assert.equal(node(`${service}#OwnerService.Estado.etiqueta`)?.kind, "method");
  });

  test("relaciona archivos por imports, comodines, imports estáticos y uso en el mismo paquete", () => {
    assertEdge(graph, service, owner, "imports"); // import com.demo.model.*
    assertEdge(graph, service, pet, "imports");
    assertEdge(graph, service, repo, "imports"); // mismo paquete, sin import
    assertEdge(graph, service, formats, "imports"); // import static
    assertEdge(graph, owner, pet, "imports"); // mismo paquete
    assertEdge(graph, owner, "pkg:java.util", "imports");
  });

  test("resuelve la herencia", () => {
    assertEdge(graph, `${owner}#Owner`, `${base}/model/BaseEntity.java#BaseEntity`, "extends");
  });

  test("resuelve llamadas por tipos declarados, var, for, herencia e interfaces", () => {
    assertEdge(graph, register, `${owner}#Owner`, "calls"); // new Owner()
    assertEdge(graph, register, `${owner}#Owner.getPets`, "calls"); // var owner
    assertEdge(graph, register, `${pet}#Pet.label`, "calls"); // for (Pet pet : …)
    assertEdge(graph, register, `${repo}#OwnerRepository.save`, "calls"); // campo de tipo interfaz
    assertEdge(graph, register, `${repo}#OwnerRepository.findById`, "calls"); // this.repo
    assertEdge(graph, register, `${base}/model/BaseEntity.java#BaseEntity.getId`, "calls"); // heredado
    assertEdge(graph, `${service}#OwnerService.helper`, register, "calls"); // método propio
  });

  test("elige la sobrecarga por cantidad de argumentos", () => {
    assertEdge(graph, register, `${owner}#Owner.addPet~2`, "calls"); // addPet("Toby", 3)
    assertEdge(graph, `${owner}#Owner.addPet~2`, `${owner}#Owner.addPet`, "calls"); // addPet(new Pet(…))
  });

  test("resuelve llamadas estáticas, imports estáticos y referencias a métodos", () => {
    const titulo = assertEdge(graph, register, `${formats}#Formats.titulo`, "calls");
    assert.equal(titulo.count, 2, "titulo(…) y Formats.titulo(…)");
  });

  test("las llamadas a la librería estándar son externas y no queda nada sin resolver", () => {
    assert.equal(graph.stats.unresolvedCalls, 0);
    assert.ok(graph.stats.externalCalls >= 6, "add, toUpperCase, trim, forEach, orElseThrow, name()…");
  });
});
