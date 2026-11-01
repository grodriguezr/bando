import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FolderTree, ROOT } from "../dist/folder-tree.js";

const files = [
  "index.html.ts",
  "src/main.tsx",
  "src/api/clientes.ts",
  "src/api/usuarios.ts",
  "src/pages/clientes/Lista.tsx",
  "src/pages/clientes/Detalle.tsx",
  "src/pages/tickets/Tickets.tsx",
  "src/utils/fechas.ts",
];

describe("FolderTree", () => {
  const tree = new FolderTree(files);

  test("incluye carpetas intermedias y cuenta archivos en todo el subárbol", () => {
    assert.deepEqual(tree.get(ROOT)?.folders, ["src"]);
    assert.deepEqual(tree.get("src")?.folders, ["src/api", "src/pages", "src/utils"]);
    assert.deepEqual(tree.get("src/pages")?.files, [], "pages solo contiene subcarpetas");
    assert.equal(tree.get("src/pages")?.totalFiles, 3);
    assert.equal(tree.get(ROOT)?.totalFiles, 8);
    assert.deepEqual(tree.ancestors("src/pages/clientes"), [ROOT, "src", "src/pages"]);
  });

  test("cada archivo se representa por su carpeta cerrada más externa", () => {
    const expanded = new Set([ROOT, "src"]);
    assert.equal(tree.representative("src/pages/clientes/Lista.tsx", expanded), "src/pages");
    assert.equal(tree.representative("src/main.tsx", expanded), "src/main.tsx");
    assert.equal(tree.representative("index.html.ts", expanded), "index.html.ts");
    assert.equal(tree.representative("src/api/clientes.ts", new Set([ROOT])), "src");
  });

  test("abre carpetas desde la raíz hasta el presupuesto de nodos visibles", () => {
    // Raíz: index.html.ts + src (2). src: 3 carpetas + main.tsx (5 visibles).
    // Las carpetas de un solo elemento se abren gratis (utils): cambian un nodo por otro.
    assert.deepEqual([...tree.defaultExpanded(5)].sort(), [ROOT, "src", "src/utils"]);
    // Con más margen abre primero las más grandes: pages (+1 → 6), api (+1 → 7); clientes ya no cabe.
    assert.deepEqual([...tree.defaultExpanded(7)].sort(), [
      ROOT,
      "src",
      "src/api",
      "src/pages",
      "src/pages/tickets",
      "src/utils",
    ]);
    assert.equal(tree.defaultExpanded(100).size, tree.folders.size, "un proyecto pequeño se abre entero");
  });

  test("nunca deja la vista inicial en una sola carpeta, aunque sea grande", () => {
    // Como un backend NestJS: src/ con 30 módulos.
    const big = new FolderTree(Array.from({ length: 30 }, (_, i) => `src/modulo${i}/servicio.ts`));
    const expanded = big.defaultExpanded(25);
    assert.ok(expanded.has("src"), "src se abre aunque muestre 30 elementos");
    assert.ok(!expanded.has("src/modulo0"), "pero no sigue abriendo más allá del límite");
  });
});
